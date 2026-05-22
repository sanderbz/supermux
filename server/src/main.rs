//! amux-v3 server entry point.
//!
//! M0 bootstrap stub: binds `127.0.0.1:8823` and serves a single root route.
//! Later milestones replace this with the full startup sequence from
//! TECH_PLAN §3.2.1 (config load, db pool init, TLS bind, background tasks).

use std::net::SocketAddr;

mod http;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let addr: SocketAddr = "127.0.0.1:8823".parse()?;

    let app = http::router();

    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("amux-v3 listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}
