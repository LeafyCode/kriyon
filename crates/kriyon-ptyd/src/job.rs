//! [Tree stop] on Windows: a Job Object.
//!
//! Windows has no sessions, process groups or signals to sweep by. It has
//! something better suited: a job. The hosted shell is put in one the moment it
//! is spawned, and every process it starts joins the same job unless it asks
//! to break away. So "everything this terminal hosts" is simply the job's
//! members — no process-table sweep, no pid-reuse guard, no grace dance.
//!
//! The job is created with `KILL_ON_JOB_CLOSE`, and its only handle is the
//! daemon's (not inheritable). However the daemon ends — a `Shutdown`, its
//! shell exiting, the app's reaper calling `TerminateProcess` on it, a panic —
//! the handle closes and Windows ends the whole tree. That is the Windows
//! equivalent of the Unix daemon turning every stop signal into a tree stop.

use std::io;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

/// The most processes [`Job::members`] reads from one job — far more than a
/// terminal runs; the ceiling only keeps the buffer bounded.
const MAX_MEMBERS: usize = 4096;

/// A Job Object that ends every member when it is terminated or dropped.
pub struct Job(HANDLE);

// SAFETY: a job handle is a kernel object handle; every call made on it here is
// thread-safe, and it is only closed once, in `Drop`.
unsafe impl Send for Job {}
// SAFETY: as above — the handle is only read after construction.
unsafe impl Sync for Job {}

impl Job {
    /// A new, empty job that kills its members when its last handle closes.
    ///
    /// # Errors
    /// When the job can't be created or configured.
    pub fn new() -> io::Result<Self> {
        // SAFETY: null attributes and name create an anonymous, non-inheritable
        // job; a null return is the error case.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(handle);
        // SAFETY: plain-old-data struct; all zeroes is a valid value.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(std::mem::size_of_val(&info)).map_err(io::Error::other)?;
        // SAFETY: `info` is valid for `size` bytes and outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Put process `pid` (and so everything it starts from now on) in the job.
    ///
    /// # Errors
    /// When the process can't be opened or assigned.
    pub fn assign(&self, pid: u32) -> io::Result<()> {
        // SAFETY: opening a process by id; a null return is the error case.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: both handles are valid for the call; `process` is closed after.
        let ok = unsafe { AssignProcessToJobObject(self.0, process) };
        let err = io::Error::last_os_error();
        // SAFETY: `process` came from `OpenProcess` above and is closed once.
        unsafe { CloseHandle(process) };
        if ok == 0 {
            return Err(err);
        }
        Ok(())
    }

    /// Every process in the job right now, as `(pid, parent pid)`, or `None`
    /// if the job or the process table can't be read.
    ///
    /// Only members are returned. A member's parent pid is trustworthy where a
    /// whole-table one is not: every member started after the shell, so no
    /// member's parent can be an older process that happened to have a pid the
    /// shell now holds.
    #[must_use]
    pub fn members(&self) -> Option<Vec<(i32, i32)>> {
        let ids = self.member_ids()?;
        // SAFETY: a process snapshot; the invalid handle is the error case.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut members = Vec::with_capacity(ids.len());
        // SAFETY: plain-old-data struct; all zeroes is valid once dwSize is set.
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap_or(0);
        // SAFETY: `entry` is valid for writes and its size is set.
        let mut more = unsafe { Process32FirstW(snapshot, &raw mut entry) } != 0;
        while more {
            if ids.contains(&(entry.th32ProcessID as usize)) {
                if let (Ok(pid), Ok(ppid)) = (
                    i32::try_from(entry.th32ProcessID),
                    i32::try_from(entry.th32ParentProcessID),
                ) {
                    members.push((pid, ppid));
                }
            }
            // SAFETY: as above.
            more = unsafe { Process32NextW(snapshot, &raw mut entry) } != 0;
        }
        // SAFETY: the snapshot handle is closed once.
        unsafe { CloseHandle(snapshot) };
        Some(members)
    }

    /// The ids of the job's processes. The list is read into a buffer that
    /// grows until it holds them all, up to [`MAX_MEMBERS`].
    fn member_ids(&self) -> Option<Vec<usize>> {
        // The list is two `u32` counts followed by one `usize` per process.
        let header = 8 / std::mem::size_of::<usize>();
        let mut capacity = 64;
        loop {
            let mut buf = vec![0usize; header + capacity];
            let size = u32::try_from(std::mem::size_of_val(buf.as_slice())).ok()?;
            // SAFETY: `buf` is valid for `size` bytes of writes and is aligned
            // for the list's `usize` entries.
            let ok = unsafe {
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr().cast(),
                    size,
                    std::ptr::null_mut(),
                )
            };
            // SAFETY: the first 8 bytes are the two counts, written above.
            let (assigned, listed) = unsafe {
                let counts = buf.as_ptr().cast::<u32>();
                (*counts, *counts.add(1))
            };
            let (assigned, listed) = (assigned as usize, listed as usize);
            if ok != 0 && listed >= assigned {
                return Some(buf[header..header + listed].to_vec());
            }
            // A failure that isn't "the buffer is too small" is final, and so
            // is a job past the ceiling.
            if (ok == 0 && assigned <= capacity) || capacity >= MAX_MEMBERS {
                return None;
            }
            capacity = (assigned + 16).min(MAX_MEMBERS);
        }
    }

    /// End every process in the job. Best-effort: an empty job is success.
    pub fn terminate(&self) {
        // SAFETY: the handle is valid for the job's lifetime.
        unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle came from `CreateJobObjectW` and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}
