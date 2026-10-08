//! Test bridge: `POST /call/<cmd>` with JSON args → engine reply bytes;
//! `GET /events` drains queued progress events. Used by the browser e2e
//! tests to drive the real engine through the real frontend.
use std::sync::{Arc, Mutex};

use chronos_engine::Engine;
use serde_json::{json, Value};
use tiny_http::{Header, Method, Response, Server};

fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:7878".into());
    let server = Arc::new(Server::http(&addr).expect("bind"));
    let engine = Arc::new(Engine::new());
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    eprintln!("engine bridge on http://{addr}");
    let cors = || Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap();
    for mut req in server.incoming_requests() {
        let engine = engine.clone();
        let events = events.clone();
        std::thread::spawn(move || {
            if req.method() == &Method::Options {
                let r = Response::empty(204)
                    .with_header(cors())
                    .with_header(Header::from_bytes("Access-Control-Allow-Headers", "content-type").unwrap())
                    .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, POST").unwrap());
                let _ = req.respond(r);
                return;
            }
            let url = req.url().to_string();
            if url == "/events" {
                let list: Vec<Value> = std::mem::take(&mut *events.lock().unwrap());
                let _ = req.respond(Response::from_string(json!(list).to_string()).with_header(cors()));
                return;
            }
            let Some(cmd) = url.strip_prefix("/call/") else {
                let _ = req.respond(Response::empty(404).with_header(cors()));
                return;
            };
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let args: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let emit = |ev: &str, payload: Value| events.lock().unwrap().push(json!({ "event": ev, "payload": payload }));
            let resp = match engine.call(cmd, args, &emit) {
                Ok(r) => Response::from_data(r.encode()).with_status_code(200),
                Err(e) => Response::from_string(e.to_string()).with_status_code(500),
            };
            let _ = req.respond(resp.with_header(cors()));
        });
    }
}
