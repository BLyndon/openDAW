//! The measurement environment, printed by every native run so each number stays attributable to a
//! machine, toolchain and build. Native only: the wasm runners record their own environment.
#![cfg(not(target_arch = "wasm32"))]

use std::process::Command;

const UNKNOWN: &str = "unknown";

/// Runs a command in the crate directory; `None` if it is missing or fails.
fn run(program: &str, arguments: &[&str]) -> Option<String> {
    let output = Command::new(program).args(arguments).current_dir(env!("CARGO_MANIFEST_DIR")).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn cpu() -> String {
    let linux = || std::fs::read_to_string("/proc/cpuinfo").ok()?.lines()
        .find(|line| line.starts_with("model name"))
        .and_then(|line| line.split(':').nth(1)).map(|name| name.trim().to_string());
    run("sysctl", &["-n", "machdep.cpu.brand_string"]).or_else(linux).unwrap_or_else(|| UNKNOWN.to_string())
}

fn os() -> String {
    match run("sw_vers", &["-productVersion"]) {
        Some(version) => format!("macOS {version}"),
        None => run("uname", &["-sr"]).unwrap_or_else(|| UNKNOWN.to_string())
    }
}

/// Short hash, with `-dirty` if tracked files differ from it: then the hash alone does not identify the code.
fn git() -> String {
    let hash = run("git", &["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| UNKNOWN.to_string());
    let dirty = run("git", &["status", "--porcelain", "--untracked-files=no"]).is_some_and(|status| !status.is_empty());
    if dirty { format!("{hash}-dirty") } else { hash }
}

/// The version of `name` this crate is built with, from its own lockfile.
fn locked_version(name: &str) -> String {
    let lockfile = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock")).unwrap_or_default();
    let name_line = format!("name = \"{name}\"");
    let mut lines = lockfile.lines();
    lines.find(|line| *line == name_line)
        .and_then(|_| lines.next())
        .and_then(|line| line.strip_prefix("version = \""))
        .map(|version| version.trim_end_matches('"').to_string())
        .unwrap_or_else(|| UNKNOWN.to_string())
}

pub fn record() -> Vec<(&'static str, String)> {
    vec![
        ("date", run("date", &["-u", "+%Y-%m-%d %H:%M UTC"]).unwrap_or_else(|| UNKNOWN.to_string())),
        ("cpu", cpu()),
        ("arch", std::env::consts::ARCH.to_string()),
        ("os", os()),
        ("rustc", run("rustc", &["-V"]).unwrap_or_else(|| UNKNOWN.to_string())),
        ("build", if cfg!(debug_assertions) { "debug" } else { "release" }.to_string()),
        ("RUSTFLAGS", std::env::var("RUSTFLAGS").unwrap_or_else(|_| "(none)".to_string())),
        ("git", git()),
        ("realfft", locked_version("realfft")),
        ("rustfft", locked_version("rustfft"))
    ]
}

/// The record as a Markdown table, to put on top of every result.
pub fn markdown() -> String {
    let rows: String = record().iter().map(|(key, value)| format!("| {key} | {value} |\n")).collect();
    format!("## Environment\n\n| Key | Value |\n|---|---|\n{rows}")
}
