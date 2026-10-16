// StoryWriter desktop shell (D-066). The window is a thin Canvas2D/React frontend; all project
// logic stays in the Node backend (`sw serve --no-ui`), which this process starts for the chosen
// project folder on a free local port and stops when the window closes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};

struct Running {
    child: Child,
    url: String,
    project: String,
}

#[derive(Default)]
struct Backend(Mutex<Option<Running>>);

/// The StoryWriter repo (where node_modules and packages/cli live). SW_REPO overrides it.
fn repo_root() -> PathBuf {
    std::env::var("SW_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join(".."))
}

fn node_bin() -> String {
    std::env::var("SW_NODE").unwrap_or_else(|_| "node".into())
}

fn sw_command(args: &[&str]) -> Command {
    let root = repo_root();
    let main = root.join("packages").join("cli").join("src").join("main.ts");
    let mut cmd = Command::new(node_bin());
    cmd.current_dir(&root).arg("--import").arg("tsx").arg(main).args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn stop(slot: &mut Option<Running>) {
    if let Some(mut r) = slot.take() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}

/// Start (or reuse) the backend for `path`; returns its base URL.
#[tauri::command]
fn open_project(path: String, state: State<Backend>) -> Result<String, String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(r) = slot.as_mut() {
        if r.project == path && r.child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            return Ok(r.url.clone());
        }
    }
    stop(&mut slot);
    if !PathBuf::from(&path).join("project.yaml").exists() {
        return Err(format!("{path} is not a StoryWriter project (no project.yaml)"));
    }
    let port = free_port()?.to_string();
    let child = sw_command(&["-p", &path, "serve", "--no-ui", "--port", &port])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("could not start the backend ({}): {e}", node_bin()))?;
    let url = format!("http://127.0.0.1:{port}");
    *slot = Some(Running { child, url: url.clone(), project: path });
    Ok(url)
}

/// `sw init <path> --name <name>`, then switch it to graph mode on first open.
#[tauri::command]
fn init_project(path: String, name: String) -> Result<(), String> {
    let out = sw_command(&["init", &path, "--name", &name]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Did the backend die (bad project, missing node)? Lets the UI show why instead of spinning.
#[tauri::command]
fn backend_alive(state: State<Backend>) -> bool {
    let mut slot = state.0.lock().unwrap();
    match slot.as_mut() {
        Some(r) => r.child.try_wait().map(|s| s.is_none()).unwrap_or(false),
        None => false,
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Backend::default())
        .invoke_handler(tauri::generate_handler![open_project, init_project, backend_alive])
        .build(tauri::generate_context!())
        .expect("failed to build the StoryWriter window");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Ok(mut slot) = handle.state::<Backend>().0.lock() {
                stop(&mut slot);
            }
        }
    });
}
