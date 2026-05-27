//! FileTransport: a host-agnostic file-ops trait (REMOTE_PLAN §RT6).
//!
//! **The seam.** Every `tokio::fs` / `std::fs` call in `files::mod.rs` (and,
//! later in RT5, `claude_config::install_hooks`) funnels through a
//! [`FileTransport`] so the handler doesn't care whether the bytes live on the
//! orchestrator's local disk or on a remote host reached over the existing SSH
//! [`HostPool`] ControlMaster. Two concrete impls:
//!
//! * [`LocalFileTransport`] — `tokio::fs::*`, the identity transform.
//! * [`SshFileTransport`]   — small shell-outs over `ssh -S <ControlPath>`
//!   (multiplexed on the pre-warmed master). Sub-second per op.
//!
//! ## Why shell-outs and NOT a protocol-level SFTP client
//!
//! The original RT6 plan considered russh + russh-sftp. We rejected that path
//! because those two crates pull in a heavy crypto stack (ring + chacha20 +
//! sha2 + …) that visibly slows `cargo build` and duplicates work already done
//! by OpenSSH's `ssh` binary, which the server already shells out to from
//! [`Transport::Ssh`]. The pragmatic choice is to keep one transport mechanism
//! across the whole codebase: `ssh -o ControlPath=… <target> -- <program>`.
//! Every op below is a one-shot `ssh` invocation that re-uses the warm
//! ControlMaster — no new TCP handshake, no new auth, sub-ms wire latency.
//!
//! TODO (future improvement): swap to protocol-level SFTP (russh-sftp) when a
//! caller needs partial-read efficiency (range reads on huge remote files) or
//! stat-without-spawn. The trait surface is stable; only `SshFileTransport`'s
//! body would change.
//!
//! ## Quoting / argv safety
//!
//! Every path is passed as a SEPARATE argv element to `ssh`. The remote shell
//! still re-interprets them, so when we have to embed a path INSIDE a `bash
//! -c` script we pass it as a positional `$1` / `$2` argument — NEVER
//! interpolate. The script body itself is a string constant. This makes the
//! ops immune to spaces, quotes, `$()`, backticks, and other shell games in
//! a user-controlled path.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use tokio::io::AsyncWriteExt;

use crate::sessions::host_pool::HostPool;
use crate::sessions::transport::{HostId, Transport};

/// A single directory entry as returned by [`FileTransport::list_dir`]. The
/// fields mirror what the `/api/ls` JSON envelope needs — directories first,
/// then by name, with a size + epoch-mtime per entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<i64>,
}

/// File metadata as returned by [`FileTransport::stat`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub is_dir: bool,
    pub size: u64,
    /// Unix epoch seconds; `0` when unknown / unsupported by the transport.
    pub modified: i64,
    pub readable: bool,
    pub writable: bool,
}

/// Host-agnostic file ops. Implementations MUST be `Send + Sync` so handlers
/// can hold them across `.await` points and `Arc`-share them.
#[async_trait]
pub trait FileTransport: Send + Sync {
    async fn read(&self, path: &Path) -> Result<Vec<u8>>;
    async fn write(&self, path: &Path, content: &[u8]) -> Result<()>;
    async fn list_dir(&self, path: &Path) -> Result<Vec<DirEntry>>;
    async fn stat(&self, path: &Path) -> Result<Stat>;
    async fn delete(&self, path: &Path) -> Result<()>;
    async fn rename(&self, from: &Path, to: &Path) -> Result<()>;

    /// Marker that's `true` ONLY for [`LocalFileTransport`]. Callers use it to
    /// take faster `tokio::fs` shortcuts (e.g. streaming reads via
    /// `safe_open_read` + `O_NOFOLLOW`) instead of routing through `read()`,
    /// which materialises the whole file in memory. Default is `false` — any
    /// new transport is assumed remote until it opts in.
    fn is_local(&self) -> bool {
        false
    }
}

// ─────────────────────────── LocalFileTransport ────────────────────────────

/// Local-disk impl. The identity transform — every op delegates straight to
/// `tokio::fs`. This is the today-path; existing local file tests must keep
/// passing byte-for-byte against this impl.
#[derive(Debug, Default, Clone, Copy)]
pub struct LocalFileTransport;

#[async_trait]
impl FileTransport for LocalFileTransport {
    fn is_local(&self) -> bool {
        true
    }

    async fn read(&self, path: &Path) -> Result<Vec<u8>> {
        tokio::fs::read(path)
            .await
            .with_context(|| format!("reading {}", path.display()))
    }

    async fn write(&self, path: &Path, content: &[u8]) -> Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating parent of {}", path.display()))?;
        }
        tokio::fs::write(path, content)
            .await
            .with_context(|| format!("writing {}", path.display()))
    }

    async fn list_dir(&self, path: &Path) -> Result<Vec<DirEntry>> {
        let mut rd = tokio::fs::read_dir(path)
            .await
            .with_context(|| format!("opening dir {}", path.display()))?;
        let mut out = Vec::new();
        while let Some(entry) = rd
            .next_entry()
            .await
            .with_context(|| format!("scanning dir {}", path.display()))?
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = match entry.metadata().await {
                Ok(m) => m,
                // Skip entries we lost a race on (deleted between read_dir
                // and metadata) — matches the existing handler's behaviour.
                Err(_) => continue,
            };
            out.push(DirEntry {
                name,
                is_dir: meta.is_dir(),
                size: Some(meta.len()),
                modified: Some(local_mtime(&meta)),
            });
        }
        Ok(out)
    }

    async fn stat(&self, path: &Path) -> Result<Stat> {
        let meta = tokio::fs::metadata(path)
            .await
            .with_context(|| format!("stat {}", path.display()))?;
        // `readable`/`writable` are best-effort: a `tokio::fs::metadata` doesn't
        // tell us whether THIS process can access the file. For the local impl
        // we conservatively report true — handlers fall back to the actual
        // open() syscall and surface EPERM at that layer if needed.
        Ok(Stat {
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: local_mtime(&meta),
            readable: true,
            writable: !meta.permissions().readonly(),
        })
    }

    async fn delete(&self, path: &Path) -> Result<()> {
        let meta = tokio::fs::symlink_metadata(path)
            .await
            .with_context(|| format!("stat {}", path.display()))?;
        if meta.is_dir() {
            tokio::fs::remove_dir_all(path)
                .await
                .with_context(|| format!("removing dir {}", path.display()))
        } else {
            tokio::fs::remove_file(path)
                .await
                .with_context(|| format!("removing {}", path.display()))
        }
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        tokio::fs::rename(from, to)
            .await
            .with_context(|| format!("renaming {} -> {}", from.display(), to.display()))
    }
}

fn local_mtime(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ──────────────────────────── SshFileTransport ─────────────────────────────

/// Remote-host impl. Each op is one `ssh` invocation that re-uses the warm
/// ControlMaster on `(host_id, control_path)`. The pool is consulted on EVERY
/// op so we transparently re-warm a master that the reaper tore down between
/// requests.
pub struct SshFileTransport {
    pub host_pool: Arc<HostPool>,
    pub host_id: HostId,
}

impl SshFileTransport {
    pub fn new(host_pool: Arc<HostPool>, host_id: HostId) -> Self {
        Self { host_pool, host_id }
    }

    /// Resolve the `Transport::Ssh` for our host_id from the pool. Errors
    /// bubble up the warm-up failure context so the handler can map it to a
    /// 503 / 5xx with a useful message.
    async fn ssh_transport(&self) -> Result<Arc<Transport>> {
        let HostId(id) = self.host_id;
        self.host_pool.transport_for(id).await
    }
}

#[async_trait]
impl FileTransport for SshFileTransport {
    async fn read(&self, path: &Path) -> Result<Vec<u8>> {
        let transport = self.ssh_transport().await?;
        let p = path_str(path)?;
        let mut cmd = transport.spawn_command("cat", &["--", p]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let out = cmd
            .output()
            .await
            .with_context(|| format!("ssh cat {}", path.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            bail!("remote read of {} failed: {}", path.display(), stderr);
        }
        Ok(out.stdout)
    }

    async fn write(&self, path: &Path, content: &[u8]) -> Result<()> {
        let transport = self.ssh_transport().await?;
        let p = path_str(path)?;
        // The script body NEVER interpolates the path. The path is passed as
        // `$1` via the trailing positional args (`_ <path>` — `_` fills `$0`).
        // mkdir -p the parent first, then write to a temp file in the same dir
        // and rename — POSIX rename(2) is atomic on the same filesystem.
        const SCRIPT: &str = r#"
set -eu
dest="$1"
dir=$(dirname -- "$dest")
mkdir -p -- "$dir"
tmp=$(mktemp -p "$dir" .supermux-write.XXXXXX)
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
chmod 0644 -- "$tmp"
mv -f -- "$tmp" "$dest"
trap - EXIT
"#;
        let mut cmd = transport.spawn_command("bash", &["-c", SCRIPT, "_", p]);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .with_context(|| format!("ssh write {}", path.display()))?;
        // Stream the content to the remote `cat > tmp`.
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(content)
                .await
                .with_context(|| format!("piping content to ssh write of {}", path.display()))?;
            stdin
                .shutdown()
                .await
                .with_context(|| format!("closing stdin to ssh write of {}", path.display()))?;
        }
        let out = child
            .wait_with_output()
            .await
            .with_context(|| format!("awaiting ssh write of {}", path.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            bail!("remote write of {} failed: {}", path.display(), stderr);
        }
        Ok(())
    }

    async fn list_dir(&self, path: &Path) -> Result<Vec<DirEntry>> {
        let transport = self.ssh_transport().await?;
        let p = path_str(path)?;
        // `find -maxdepth 1` is much easier to parse than `ls -la`. The format
        // is `<type>\t<size>\t<mtime>\t<basename>` per entry, one entry per
        // line. The dir itself appears as `.` which we filter out.
        //
        // NOTE: `find` differs subtly across coreutils vs BSD; we target GNU
        // here (the typical Linux remote) and accept that macOS hosts won't
        // be the common case for RT6.
        let mut cmd = transport.spawn_command(
            "find",
            &[
                "--",
                p,
                "-maxdepth",
                "1",
                "-mindepth",
                "1",
                "-printf",
                "%y\t%s\t%T@\t%f\n",
            ],
        );
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let out = cmd
            .output()
            .await
            .with_context(|| format!("ssh ls {}", path.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            bail!("remote ls of {} failed: {}", path.display(), stderr);
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut entries = Vec::new();
        for line in text.lines() {
            let mut parts = line.splitn(4, '\t');
            let kind = parts.next().unwrap_or("");
            let size: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            // mtime is `%T@` which is `<sec>.<frac>` — take the integer part.
            let mtime: i64 = parts
                .next()
                .and_then(|s| s.split('.').next())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let name = parts.next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            entries.push(DirEntry {
                name,
                is_dir: kind == "d",
                size: Some(size),
                modified: Some(mtime),
            });
        }
        Ok(entries)
    }

    async fn stat(&self, path: &Path) -> Result<Stat> {
        let transport = self.ssh_transport().await?;
        let p = path_str(path)?;
        // `%F` = file type description, `%s` = size, `%Y` = mtime epoch,
        // `%a` = octal perms. Tab-separated for easy parsing.
        let mut cmd = transport.spawn_command(
            "stat",
            &["-c", "%F\t%s\t%Y\t%a", "--", p],
        );
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let out = cmd
            .output()
            .await
            .with_context(|| format!("ssh stat {}", path.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            bail!("remote stat of {} failed: {}", path.display(), stderr);
        }
        let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let mut parts = line.splitn(4, '\t');
        let kind = parts.next().unwrap_or("").to_string();
        let size: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let mtime: i64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let perms: u32 = parts
            .next()
            .and_then(|s| u32::from_str_radix(s, 8).ok())
            .unwrap_or(0);
        let is_dir = kind.contains("directory");
        // Owner-mode bits are what the remote shell user (== us, multiplexed
        // over the master) actually has — refine if it ever matters.
        let readable = perms & 0o400 != 0;
        let writable = perms & 0o200 != 0;
        Ok(Stat {
            is_dir,
            size,
            modified: mtime,
            readable,
            writable,
        })
    }

    async fn delete(&self, path: &Path) -> Result<()> {
        let transport = self.ssh_transport().await?;
        let p = path_str(path)?;
        // SAFETY: refuse to recursively delete a directory over the remote
        // transport. A `rm -rf` over the wire on a mistyped path is an order
        // of magnitude harder to recover from than the local case. Caller
        // (the handler) gets a clean error and can surface the limitation.
        // First, stat the path to decide.
        let s = self.stat(path).await?;
        if s.is_dir {
            bail!(
                "refusing to delete directory {} over the remote transport (single-file deletes only in RT6 MVP)",
                path.display()
            );
        }
        let mut cmd = transport.spawn_command("rm", &["-f", "--", p]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let out = cmd
            .output()
            .await
            .with_context(|| format!("ssh rm {}", path.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            bail!("remote delete of {} failed: {}", path.display(), stderr);
        }
        Ok(())
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<()> {
        let transport = self.ssh_transport().await?;
        let f = path_str(from)?;
        let t = path_str(to)?;
        let mut cmd = transport.spawn_command("mv", &["--", f, t]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let out = cmd
            .output()
            .await
            .with_context(|| format!("ssh mv {} -> {}", from.display(), to.display()))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            bail!(
                "remote rename of {} -> {} failed: {}",
                from.display(),
                to.display(),
                stderr
            );
        }
        Ok(())
    }
}

/// Validate + convert a `Path` to an `&str` for arg passing. NUL bytes are
/// rejected — those would confuse the kernel's argv handling AND any shell
/// downstream. Non-UTF-8 paths on Unix are rare for our use case (we operate
/// on user-supplied absolute paths typed into the UI); reject them with a
/// clean error rather than corrupt them via lossy conversion.
fn path_str(path: &Path) -> Result<&str> {
    let s = path
        .to_str()
        .ok_or_else(|| anyhow!("path {} is not valid UTF-8", path.display()))?;
    if s.as_bytes().contains(&0) {
        bail!("path contains a NUL byte: {}", path.display());
    }
    Ok(s)
}

// ──────────────────────────── resolver helpers ─────────────────────────────

/// Either of the two transport impls, packaged behind the trait so handlers
/// can keep one `Arc<dyn FileTransport>` and not branch.
pub fn local() -> Arc<dyn FileTransport> {
    Arc::new(LocalFileTransport)
}

/// Resolve a transport from an optional `host_id` (typically pulled from a
/// `sessions.host_id` column). `None` → local. `Some(id)` → ssh.
pub fn resolve(
    host_pool: &Arc<HostPool>,
    host_id: Option<i64>,
) -> Arc<dyn FileTransport> {
    match host_id {
        None => local(),
        Some(id) => Arc::new(SshFileTransport::new(host_pool.clone(), HostId(id))),
    }
}

/// Stable path-equality string used by the path-safety blocklist, mirrored
/// here so both `path_safe::resolve_safe` and any direct transport caller use
/// the SAME normalization. Case-folding defeats the macOS `/ETC/SHADOW`
/// trick; the rest is byte-for-byte.
pub fn normalize_for_blocklist(path: &Path) -> String {
    path.to_string_lossy().to_lowercase()
}

// ─────────────────────────────── tests ─────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "supermux-filetransport-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn local_write_then_read_roundtrip() {
        let dir = tmp_dir();
        let path = dir.join("hello.txt");
        let t = LocalFileTransport;
        t.write(&path, b"hello, world\n").await.unwrap();
        let got = t.read(&path).await.unwrap();
        assert_eq!(got, b"hello, world\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn local_write_creates_parents() {
        let dir = tmp_dir();
        let path = dir.join("nested/sub/dir/leaf.md");
        let t = LocalFileTransport;
        t.write(&path, b"# hi\n").await.unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn local_list_dir_returns_entries() {
        let dir = tmp_dir();
        std::fs::write(dir.join("a.txt"), b"a").unwrap();
        std::fs::write(dir.join("b.txt"), b"bb").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        let t = LocalFileTransport;
        let mut entries = t.list_dir(&dir).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries.len(), 3);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "sub"]);
        assert!(entries.iter().find(|e| e.name == "sub").unwrap().is_dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn local_stat_returns_metadata() {
        let dir = tmp_dir();
        let path = dir.join("data.bin");
        std::fs::write(&path, vec![0u8; 1024]).unwrap();
        let t = LocalFileTransport;
        let s = t.stat(&path).await.unwrap();
        assert!(!s.is_dir);
        assert_eq!(s.size, 1024);
        assert!(s.readable);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn local_delete_then_stat_errors() {
        let dir = tmp_dir();
        let path = dir.join("ephemeral.txt");
        std::fs::write(&path, b"poof").unwrap();
        let t = LocalFileTransport;
        t.delete(&path).await.unwrap();
        assert!(t.stat(&path).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn local_rename_moves_file() {
        let dir = tmp_dir();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, b"x").unwrap();
        let t = LocalFileTransport;
        t.rename(&a, &b).await.unwrap();
        assert!(!a.exists());
        assert!(b.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn path_str_rejects_nul() {
        let bad = PathBuf::from("/tmp/foo\0bar");
        assert!(path_str(&bad).is_err());
    }

    #[test]
    fn normalize_for_blocklist_is_case_insensitive() {
        assert_eq!(
            normalize_for_blocklist(Path::new("/ETC/SHADOW")),
            "/etc/shadow"
        );
    }
}
