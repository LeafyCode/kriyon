//! The process table on Windows, and ending a process there.
//!
//! macOS reads its table from `ps`. Windows has no `ps`: the processes come
//! from a Toolhelp snapshot, and each one's command line from the process
//! itself. [`kriyon_core::proc::rows_from_windows`] turns them into the rows
//! the rest of the app already understands.

use kriyon_core::proc::{ProcRow, WindowsProcess};
use windows_sys::Wdk::System::Threading::NtQueryInformationProcess;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

/// `ProcessCommandLineInformation`: the process's command line as a
/// `UNICODE_STRING` followed by its text.
const PROCESS_COMMAND_LINE_INFORMATION: i32 = 60;

/// One sweep of every process, or `None` when the snapshot can't be taken.
#[must_use]
pub fn sweep() -> Option<Vec<ProcRow>> {
    // SAFETY: a process snapshot; the invalid handle is the error case.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut procs = Vec::new();
    // SAFETY: plain-old-data struct; all zeroes is valid once dwSize is set.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap_or(0);
    // SAFETY: `entry` is valid for writes and its size is set.
    let mut more = unsafe { Process32FirstW(snapshot, &raw mut entry) } != 0;
    while more {
        let len = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
        if let (Ok(pid), Ok(ppid)) = (
            i32::try_from(entry.th32ProcessID),
            i32::try_from(entry.th32ParentProcessID),
        ) {
            if pid > 0 {
                procs.push(WindowsProcess {
                    pid,
                    ppid,
                    exe,
                    args: arguments(entry.th32ProcessID),
                });
            }
        }
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot, &raw mut entry) } != 0;
    }
    // SAFETY: the snapshot handle is closed once.
    unsafe { CloseHandle(snapshot) };
    (!procs.is_empty()).then(|| kriyon_core::proc::rows_from_windows(&procs))
}

/// The arguments `pid` was started with, after the program; empty when its
/// command line can't be read.
fn arguments(pid: u32) -> Vec<String> {
    let Some(line) = command_line(pid) else {
        return Vec::new();
    };
    let wide: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
    let mut found = 0_i32;
    // SAFETY: `wide` is NUL-terminated; the returned block is freed below.
    let list = unsafe { CommandLineToArgvW(wide.as_ptr(), &raw mut found) };
    if list.is_null() {
        return Vec::new();
    }
    let found = usize::try_from(found).unwrap_or(0);
    let mut args = Vec::with_capacity(found.saturating_sub(1));
    for i in 1..found {
        // SAFETY: `list` holds `found` NUL-terminated wide strings.
        let text = unsafe { *list.add(i) };
        let mut len = 0;
        // SAFETY: each string is NUL-terminated.
        while unsafe { *text.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` wide chars precede the NUL.
        args.push(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(text, len)
        }));
    }
    // SAFETY: `list` came from `CommandLineToArgvW` and is freed once.
    unsafe { windows_sys::Win32::Foundation::LocalFree(list.cast()) };
    args
}

/// `pid`'s full command line, or `None` when the process can't be opened (it
/// belongs to another user, or is protected) or has already gone.
fn command_line(pid: u32) -> Option<String> {
    // SAFETY: opening a process by id; a null handle is the error case.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let line = query_command_line(process);
    // SAFETY: `process` came from `OpenProcess` and is closed once.
    unsafe { CloseHandle(process) };
    line
}

fn query_command_line(process: HANDLE) -> Option<String> {
    // Ask for the size first, then read into a buffer that fits, aligned for
    // the `UNICODE_STRING` header it starts with.
    let mut needed = 0_u32;
    // SAFETY: a size query with no buffer; it only writes `needed`.
    unsafe {
        NtQueryInformationProcess(
            process,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &raw mut needed,
        )
    };
    if needed == 0 {
        return None;
    }
    let words = usize::try_from(needed).ok()?.div_ceil(8);
    let mut buf = vec![0_u64; words];
    // SAFETY: `buf` is valid for `needed` bytes of writes.
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            PROCESS_COMMAND_LINE_INFORMATION,
            buf.as_mut_ptr().cast(),
            needed,
            &raw mut needed,
        )
    };
    if status < 0 {
        return None;
    }
    // SAFETY: the buffer now starts with a `UNICODE_STRING` whose text points
    // into the same buffer.
    let text = unsafe {
        let header = &*buf
            .as_ptr()
            .cast::<windows_sys::Win32::Foundation::UNICODE_STRING>();
        if header.Buffer.is_null() {
            return None;
        }
        std::slice::from_raw_parts(header.Buffer, usize::from(header.Length) / 2)
    };
    Some(String::from_utf16_lossy(text))
}

/// End `pid` outright. For a [PTY daemon] this is a [Tree stop]: the daemon's
/// Job Object closes with it, which ends its shell and everything under it.
/// Best-effort: a process that already exited is fine.
pub fn terminate(pid: i32) {
    let Ok(pid) = u32::try_from(pid) else {
        return;
    };
    // SAFETY: opening a process by id; a null handle is the error case.
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        return;
    }
    // SAFETY: `process` is a valid handle with terminate access, closed once.
    unsafe {
        TerminateProcess(process, 1);
        CloseHandle(process);
    }
}
