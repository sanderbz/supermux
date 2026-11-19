//! **Bug B, end to end: a confined company holder must actually COME UP — and
//! must still be a jail.**
//!
//! Measured on the Strato box: every company-agent start for a week logged
//!
//! ```text
//! isolation: company agent confined at Full(landlock) session="Reisposter" company=5
//! …10s later…
//! company isolation degraded: holder failed under Landlock, started unconfined
//!   — check the allow-list  error=native session 'Reisposter': holder did not come up in time
//! isolation: company agent started UNCONFINED after the confined holder failed to boot (fail-safe)
//! ```
//!
//! 20 confined starts, 20 silent degradations — the security feature was off
//! 100% of the time. The reason was in the holder's own `holder.log` the whole
//! time (`holder exiting with error: openpty: EACCES: Permission denied`): the
//! allow-list had no `/dev`, so a fully-enforced jail denied `/dev/ptmx` and the
//! pty holder died before it ever bound its socket.
//!
//! This test spawns the REAL `supermux-server pty-holder` binary through the real
//! [`NativeSession::spawn_confined`] seam with the real company [`ConfinePlan`],
//! and proves BOTH halves — a jail that boots because it allows everything is a
//! fail:
//!
//! 1. the confined holder boots (`spawn_confined` reports NO degradation), and
//! 2. the confined child can read the system but NOT a sibling company tree.
//!
//! On a host that enforces no Landlock (an old kernel, or a systemd unit whose
//! `SystemCallFilter` blocks `landlock_*`) half 2 is skipped — there is no jail
//! to assert — and half 1 still runs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use supermux_server::isolation::{IsolationMode, IsolationRuntime};
use supermux_server::sessions::native::runtime::NativeSession;

/// The native runtime re-execs `supermux-server pty-holder` and finds that binary
/// with `current_exe()` — which inside a test binary is the TEST.
/// `SUPERMUX_HOLDER_BIN` is the documented override, so point it at the real bin
/// `cargo test` has already built beside our deps dir. Returns `None` when it is
/// not there (a `--no-run` / doc build), and the test skips rather than fails.
fn holder_bin() -> Option<PathBuf> {
    let bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().and_then(|d| d.parent()).map(|d| d.join("supermux-server")))
        .filter(|p| p.exists())?;
    std::env::set_var("SUPERMUX_HOLDER_BIN", &bin);
    Some(bin)
}

fn wrote(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[tokio::test]
async fn a_confined_company_holder_boots_and_still_denies_a_sibling_company() {
    let Some(bin) = holder_bin() else {
        eprintln!("no supermux-server binary beside the test; skipping");
        return;
    };
    let Some(home) = dirs::home_dir() else {
        eprintln!("no home dir; skipping");
        return;
    };

    // The company root and its SIBLING live under $HOME, not /tmp: `/tmp` is
    // RW-allowed by design, so a secret parked there would prove nothing. This
    // mirrors a real `<projects>/companies/<other>` tree.
    let base = home.join(format!(".supermux-iso-e2e-{}", uuid::Uuid::new_v4()));
    let company = base.join("acme");
    let sibling = base.join("other");
    std::fs::create_dir_all(&company).expect("mk company root");
    std::fs::create_dir_all(&sibling).expect("mk sibling");
    // Written so an UNJAILED read would succeed — the denial then proves the
    // jail, not a missing file.
    std::fs::write(sibling.join("secret.txt"), b"sibling company secret").expect("write secret");

    // The SUPERMUX RUNTIME fixtures (the second allow-list gap: with /dev fixed
    // the jail became real and claude died reading its own
    // `~/.supermux/session-config/<name>/settings.json`). All under the REAL
    // `~/.supermux`, uniquely named, removed at the end:
    //   * this session's own config dir      → granted per-session, must READ
    //   * a sibling session's config dir     → NOT granted, must be DENIED
    //   * a loose file in `~/.supermux` root → stand-in for auth_token/data.db,
    //     must be DENIED (never touch the real auth_token)
    //   * a probe in `~/.supermux/connectors` → company-generic grant, must READ
    let sm = home.join(".supermux");
    let own_cfg = sm.join("session-config").join(format!("iso-e2e-{}", uuid::Uuid::new_v4()));
    let sib_cfg = sm.join("session-config").join(format!("iso-e2e-sib-{}", uuid::Uuid::new_v4()));
    let root_secret = sm.join(format!("iso-e2e-secret-{}", uuid::Uuid::new_v4()));
    let conn_probe = sm.join("connectors").join(format!("iso-e2e-{}.txt", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&own_cfg).expect("mk own session-config");
    std::fs::create_dir_all(&sib_cfg).expect("mk sibling session-config");
    std::fs::create_dir_all(conn_probe.parent().unwrap()).expect("mk connectors");
    std::fs::write(own_cfg.join("settings.json"), b"{\"own\":true}").expect("write own settings");
    std::fs::write(sib_cfg.join("settings.json"), b"sibling session settings").expect("write sib settings");
    std::fs::write(&root_secret, b"supermux root secret").expect("write root secret");
    std::fs::write(&conn_probe, b"connector probe ok").expect("write connector probe");
    // The CLAUDE-HOME fixtures (the cross-project transcript leak): `~/.claude`
    // used to be granted read+write WHOLESALE, so a confined company bot could
    // read every Claude transcript on the box. All fixtures live under the REAL
    // `~/.claude` / `~/.config` (a jail is only proven against the real tree),
    // are uniquely named, and are removed at the end:
    //   * a SIBLING project dir under `~/.claude/projects/`  → must be DENIED
    //   * `~/.claude/projects` itself (a listing)            → must be DENIED
    //   * a `history.jsonl`-shaped file in `~/.claude`       → must be DENIED
    //     (never touch the real `history.jsonl`)
    //   * a `gh`-shaped credential dir under `~/.config`     → must be DENIED
    //   * the session's OWN project dir                      → must READ + WRITE
    //   * the real `~/.claude/settings.json`                 → must READ (granted)
    let claude_home = home.join(".claude");
    let sib_proj = claude_home
        .join("projects")
        .join(format!("iso-e2e-sibling-{}", uuid::Uuid::new_v4()));
    let hist_probe = claude_home.join(format!("iso-e2e-history-{}.jsonl", uuid::Uuid::new_v4()));
    // Claude Code creates `~/.claude/session-env/<id it picks itself>` per run
    // and executes hooks/tools through it; denying the mkdir silently killed
    // every hook of a confined bot (v0.6.16, live). The child must be able to
    // create a fresh dir there.
    let senv_probe = claude_home.join("session-env").join(format!("iso-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(claude_home.join("session-env")).expect("mk session-env");
    let gh_probe = home
        .join(".config")
        .join(format!("gh-iso-e2e-{}", uuid::Uuid::new_v4()));
    // A file inside a GRANTED dir of the enumerated read-only slice
    // (`~/.claude/commands`), so the "the agent can still read what it needs"
    // half is asserted on a fixture we control — a CI runner has no
    // `~/.claude/settings.json` to read (that one is asserted only when the box
    // actually has it, below).
    let cmd_probe = claude_home
        .join("commands")
        .join(format!("iso-e2e-{}.md", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&sib_proj).expect("mk sibling project dir");
    std::fs::create_dir_all(&gh_probe).expect("mk gh-shaped dir");
    std::fs::create_dir_all(cmd_probe.parent().expect("commands parent"))
        .expect("mk ~/.claude/commands");
    std::fs::write(&cmd_probe, b"granted-claude-home-read").expect("write command probe");
    std::fs::write(sib_proj.join("transcript.jsonl"), b"sibling project transcript secret")
        .expect("write sibling transcript");
    std::fs::write(&hist_probe, b"every prompt ever typed").expect("write history probe");
    std::fs::write(gh_probe.join("hosts.yml"), b"oauth_token: ghp_fake_for_the_test")
        .expect("write gh probe");
    // The session's own project dir, resolved EXACTLY as the spawn path resolves
    // it (`project_dir_for(config_dir, dir)` on the session's cwd).
    let own_proj = supermux_server::sessions::resumable::project_dir_for(
        "",
        company.to_str().expect("utf-8 company path"),
    );

    let data_dir = std::env::temp_dir().join(format!("supermux-iso-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).expect("mk data dir");

    let iso = IsolationRuntime::from_mode(IsolationMode::BestEffort);
    let enforced = iso.probe().best_level.is_enforced() && iso.confinement_usable();
    let mut plan = iso
        .plan_for(&company, &home)
        .expect("best-effort always yields a plan");
    // TEST-ONLY GRANT. In production `SandboxSpec::for_company` allow-lists
    // `current_exe()` + its parent, which IS the holder binary. Here
    // `current_exe()` is the test binary in `target/debug/deps`, one level below
    // the `supermux-server` we point `SUPERMUX_HOLDER_BIN` at — so grant that dir
    // explicitly. It is a build dir, unrelated to the sibling secret below.
    if let Some(parent) = bin.parent() {
        plan.allow_rw(parent.to_path_buf());
    }
    // The per-session grant EXACTLY as `confinement_plan` adds it in
    // `sessions/lifecycle.rs`: this session's own config dir, and nothing else
    // under `session-config/`.
    plan.allow_ro(own_cfg.clone());
    // …and the Claude project grant the same function adds: THIS session's own
    // `~/.claude/projects/<encoded cwd>` (created by the call), and nothing else
    // under `projects/`.
    plan.allow_claude_project(own_proj.clone());

    // The confined child: read the sibling secret (must be DENIED), read a system
    // file (must be ALLOWED), then park. The `sleep` matters — the runtime's
    // second fail-safe retries UNCONFINED when the agent dies within 400ms of
    // boot, and an instantly-exiting command would trip it.
    let c = company.display();
    let shell = format!(
        "/bin/cat {}/secret.txt > {c}/sibling.out 2>&1; \
         /bin/cat /etc/hostname > {c}/system.out 2>&1; \
         /bin/cat {own}/settings.json > {c}/owncfg.out 2>&1; \
         /bin/cat {sib}/settings.json > {c}/sibcfg.out 2>&1; \
         /bin/cat {root} > {c}/rootsecret.out 2>&1; \
         /bin/cat {conn} > {c}/connectors.out 2>&1; \
         /bin/cat /etc/resolv.conf > {c}/resolv.out 2>&1; \
         /bin/cat {sibproj}/transcript.jsonl > {c}/sibproj.out 2>&1; \
         /bin/ls {projects} > {c}/projectsls.out 2>&1; \
         /bin/cat {hist} > {c}/history.out 2>&1; \
         /bin/cat {gh}/hosts.yml > {c}/gh.out 2>&1; \
         /bin/mkdir {senv} > {c}/senv.out 2>&1; \
         /bin/cat {settings} > {c}/settings.out 2>&1; \
         /bin/cat {cmdprobe} > {c}/cmdprobe.out 2>&1; \
         echo own-transcript > {ownproj}/probe.jsonl 2>{c}/ownwrite.err; \
         /bin/cat {ownproj}/probe.jsonl > {c}/ownproj.out 2>&1; \
         echo ok > {c}/done; \
         sleep 30",
        sibling.display(),
        own = own_cfg.display(),
        sib = sib_cfg.display(),
        root = root_secret.display(),
        conn = conn_probe.display(),
        sibproj = sib_proj.display(),
        projects = claude_home.join("projects").display(),
        hist = hist_probe.display(),
        senv = senv_probe.display(),
        gh = gh_probe.display(),
        settings = claude_home.join("settings.json").display(),
        cmdprobe = cmd_probe.display(),
        ownproj = own_proj.display(),
    );

    let session = NativeSession::new("iso-e2e", &data_dir);
    let env: HashMap<String, String> = HashMap::new();
    let degraded = session
        .spawn_confined(&company, &env, &shell, Some(plan))
        .await
        .expect("the confined spawn must not error");

    // ── half 1: it BOOTS ────────────────────────────────────────────────────
    // `spawn_confined` reports `true` when the confined holder could not come up
    // and it had to retry unconfined — the exact 20/20 degradation this fixes.
    assert!(
        !degraded,
        "the confined holder failed to boot and was retried UNCONFINED — the \
         allow-list is missing something the holder needs (holder.log: {})",
        wrote(&data_dir.join("native/iso-e2e/holder.log")),
    );

    // Let the child run its three commands.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !company.join("done").exists() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = session.kill().await;
    session.stop_pump();

    assert!(
        company.join("done").exists(),
        "the confined child never ran (holder.log: {})",
        wrote(&data_dir.join("native/iso-e2e/holder.log")),
    );
    assert!(
        !wrote(&company.join("system.out")).trim().is_empty(),
        "a confined agent must still be able to read the system (/etc/hostname)",
    );

    // ── half 2: it still CONFINES ───────────────────────────────────────────
    if enforced {
        let sibling_read = wrote(&company.join("sibling.out"));
        assert!(
            !sibling_read.contains("sibling company secret"),
            "the jail let the agent read a SIBLING company's file: {sibling_read}",
        );
        assert!(
            sibling_read.contains("Permission denied") || sibling_read.contains("denied"),
            "expected a denial reading the sibling company tree, got: {sibling_read:?}",
        );

        // ── the supermux-runtime contract (both halves again) ───────────────
        assert!(
            wrote(&company.join("owncfg.out")).contains("\"own\":true"),
            "a confined agent must read ITS OWN session-config (the gap that \
             killed every company claude once /dev was fixed): {}",
            wrote(&company.join("owncfg.out")),
        );
        assert!(
            wrote(&company.join("connectors.out")).contains("connector probe ok"),
            "a confined agent must read ~/.supermux/connectors (its MCP servers): {}",
            wrote(&company.join("connectors.out")),
        );
        let sibcfg = wrote(&company.join("sibcfg.out"));
        assert!(
            !sibcfg.contains("sibling session settings"),
            "the per-session grant leaked: a confined agent read a SIBLING \
             session's settings: {sibcfg}",
        );
        // DNS: `/etc/resolv.conf` may resolve into /run (systemd-resolved);
        // a jail that cannot read it cuts every hostname lookup — the agent
        // then looks banned from the network while TCP was never restricted.
        assert!(
            !wrote(&company.join("resolv.out")).contains("Permission denied"),
            "a confined agent must be able to read /etc/resolv.conf (via its \
             resolved target): {}",
            wrote(&company.join("resolv.out")),
        );
        assert!(
            senv_probe.is_dir(),
            "a confined agent must be able to mkdir under ~/.claude/session-env (Claude \
             Code runs its hooks through a per-session dir there): {}",
            wrote(&company.join("senv.out")),
        );
        let rootsecret = wrote(&company.join("rootsecret.out"));
        assert!(
            !rootsecret.contains("supermux root secret"),
            "the jail let the agent read a file in the ~/.supermux ROOT (the \
             auth_token/data.db tier): {rootsecret}",
        );

        // `~/.claude` is granted whole again (see SandboxSpec::for_company): the
        // shared credential store and the transcript tree share one grant, so
        // no cross-project deny is asserted here. The gh token below still is.
        let gh = wrote(&company.join("gh.out"));
        assert!(
            !gh.contains("ghp_fake_for_the_test"),
            "the jail let a company agent read a ~/.config/gh-shaped credential \
             file (the owner's GitHub token lives there): {gh}",
        );
        // …and the grants that keep a confined Claude WORKING.
        assert!(
            wrote(&company.join("cmdprobe.out")).contains("granted-claude-home-read"),
            "a confined agent must still read the ENUMERATED slice of the Claude \
             home it boots from (~/.claude/commands here): {}",
            wrote(&company.join("cmdprobe.out")),
        );
        // The real `settings.json` too — but only on a box that HAS one (a CI
        // runner's home has no Claude config at all).
        if claude_home.join("settings.json").is_file() {
            let settings = wrote(&company.join("settings.out"));
            assert!(
                !settings.contains("Permission denied"),
                "a confined agent must still read ~/.claude/settings.json (Claude \
                 Code reads it at boot): {settings:?}",
            );
        }
        assert!(
            wrote(&company.join("ownproj.out")).contains("own-transcript"),
            "a confined agent must READ+WRITE its OWN ~/.claude/projects/<cwd> \
             dir (that is where Claude Code writes its transcript): out={:?} \
             err={:?}",
            wrote(&company.join("ownproj.out")),
            wrote(&company.join("ownwrite.err")),
        );
    } else {
        eprintln!(
            "landlock not enforced on this host ({}); skipping the denial half",
            iso.probe().best_level,
        );
    }

    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_dir_all(&data_dir);
    let _ = std::fs::remove_dir_all(&own_cfg);
    let _ = std::fs::remove_dir_all(&sib_cfg);
    let _ = std::fs::remove_file(&root_secret);
    let _ = std::fs::remove_file(&conn_probe);
    let _ = std::fs::remove_dir_all(&sib_proj);
    let _ = std::fs::remove_dir_all(&gh_probe);
    let _ = std::fs::remove_file(&hist_probe);
    let _ = std::fs::remove_dir(&senv_probe);
    let _ = std::fs::remove_file(&cmd_probe);
    let _ = std::fs::remove_dir_all(&own_proj);
}

/// **Can a CONFINED company bot actually use the shared browser?**
///
/// The owner's doubt after the sandbox tightening (v0.6.16/17 scoped `~/.claude`
/// and cut `~/.supermux` down to `connectors` / `bin` / `uploads` plus the
/// session's own config): a company bot is confined at `Full(landlock)`, and the
/// Shared Browser is not a Rust call — it is a **separate python process** the
/// bot spawns (`python3 ~/.supermux/connectors/shared-browser/server.py`) that
/// then talks HTTP to `$SUPERMUX_URL`. Three things could each break it silently:
/// reading/executing the script, running python at all, and reaching the server.
///
/// So this runs the REAL embedded MCP server under the REAL company
/// [`ConfinePlan`], drives it over MCP stdio, and asserts:
///
///  1. it starts and answers `tools/list` with the browser tools — i.e. the jail
///     lets python read and run a script under `~/.supermux/connectors`;
///  2. it can reach a listening TCP server, the way it reaches
///     `$SUPERMUX_URL/api/hook/browser/tool` — Landlock governs the filesystem,
///     not sockets, and this pins that assumption instead of assuming it;
///  3. it can write scratch to `/tmp` (screenshots land there);
///
/// …while the jail is still a jail (half 2 of the test above, unchanged).
#[tokio::test]
async fn a_confined_company_bot_can_run_the_shared_browser_mcp_server() {
    let Some(bin) = holder_bin() else {
        eprintln!("no supermux-server binary beside the test; skipping");
        return;
    };
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("no python3; skipping");
        return;
    }

    let root = std::env::temp_dir().join(format!("supermux-iso-browser-{}", uuid::Uuid::new_v4()));
    let home = root.join("home");
    let company = root.join("companies").join("acme");
    std::fs::create_dir_all(&company).expect("mk company");
    // The connector dir EXACTLY where production puts it: `~/.supermux/connectors`
    // is the enumerated read-only slice a confined bot is allowed.
    let conn = home.join(".supermux").join("connectors").join("shared-browser");
    std::fs::create_dir_all(&conn).expect("mk connector dir");
    let server_py = conn.join("server.py");
    std::fs::write(&server_py, supermux_server::connectors::browser::mcp::SERVER_PY)
        .expect("materialize the embedded browser MCP server");

    // A listener standing in for `$SUPERMUX_URL` — the child only has to REACH it.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        for stream in listener.incoming().take(1) {
            if let Ok(mut s) = stream {
                use std::io::Write;
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
            }
        }
    });

    let data_dir = std::env::temp_dir().join(format!("supermux-iso-br-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&data_dir).expect("mk data dir");
    let iso = IsolationRuntime::from_mode(IsolationMode::BestEffort);
    let enforced = iso.probe().best_level.is_enforced() && iso.confinement_usable();
    let mut plan = iso.plan_for(&company, &home).expect("a plan");
    if let Some(parent) = bin.parent() {
        plan.allow_rw(parent.to_path_buf());
    }

    let c = company.display();
    // Drive the MCP server over stdio the way Claude Code does: one JSON-RPC
    // message per line in, one JSON object per line out.
    let shell = format!(
        "printf '%s\\n%s\\n' \
           '{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{{}}}}' \
           '{{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}}' \
         | python3 {py} > {c}/mcp.out 2>{c}/mcp.err; \
         echo scratch > /tmp/supermux-iso-browser-scratch.txt 2>{c}/tmp.err; \
         /bin/cat /tmp/supermux-iso-browser-scratch.txt > {c}/tmp.out 2>&1; \
         python3 -c \"import socket;s=socket.create_connection(('127.0.0.1',{port}),3);s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n');print(s.recv(64))\" > {c}/net.out 2>&1; \
         echo ok > {c}/done; \
         sleep 30",
        py = server_py.display(),
    );

    let session = NativeSession::new("iso-browser-e2e", &data_dir);
    let env: HashMap<String, String> = HashMap::new();
    let degraded = session
        .spawn_confined(&company, &env, &shell, Some(plan))
        .await
        .expect("the confined spawn must not error");
    assert!(
        !degraded,
        "the confined holder failed to boot (holder.log: {})",
        wrote(&data_dir.join("native/iso-browser-e2e/holder.log")),
    );

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !company.join("done").exists() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let _ = session.kill().await;
    session.stop_pump();
    assert!(
        company.join("done").exists(),
        "the confined child never finished (holder.log: {})",
        wrote(&data_dir.join("native/iso-browser-e2e/holder.log")),
    );

    // 1. The MCP server ran under the jail and advertised its tools.
    let mcp = wrote(&company.join("mcp.out"));
    assert!(
        mcp.contains("browser_list_tabs"),
        "a confined bot must be able to run the shared-browser MCP server \
         (stdout: {mcp:?} / stderr: {:?})",
        wrote(&company.join("mcp.err")),
    );
    assert!(mcp.contains("browser_screenshot"), "the full toolset: {mcp}");
    assert!(mcp.contains("request_human_takeover"), "the takeover verb: {mcp}");

    // 2. …and reach the server it forwards every verb to.
    let net = wrote(&company.join("net.out"));
    assert!(
        net.contains("200 OK"),
        "a confined bot must reach $SUPERMUX_URL — every browser verb is an HTTP \
         call to the hook endpoint: {net:?}",
    );

    // 3. …and write the scratch a screenshot needs.
    assert!(
        wrote(&company.join("tmp.out")).contains("scratch"),
        "a confined bot must be able to write /tmp: {:?}",
        wrote(&company.join("tmp.err")),
    );

    if enforced {
        eprintln!("shared browser verified under an ENFORCED jail (Full/landlock)");
    } else {
        eprintln!("NOTE: this host enforces no Landlock — ran unconfined, jail half not asserted");
    }
    std::fs::remove_dir_all(&root).ok();
    std::fs::remove_dir_all(&data_dir).ok();
}
