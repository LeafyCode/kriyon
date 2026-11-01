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

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

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

    /// How many processes are in the job right now, or `None` if it can't be read.
    #[must_use]
    pub fn active_processes(&self) -> Option<u32> {
        // SAFETY: plain-old-data struct; all zeroes is a valid value.
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let size = u32::try_from(std::mem::size_of_val(&info)).ok()?;
        // SAFETY: `info` is valid for `size` bytes of writes.
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                size,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(info.ActiveProcesses)
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
