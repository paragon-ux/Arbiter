#[cfg(windows)]
#[allow(non_camel_case_types)]
mod imp {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU64, Ordering};

    type HANDLE = *mut c_void;
    type BOOL = i32;
    type DWORD = u32;
    type SIZE_T = usize;
    type ULONG_PTR = usize;

    const FALSE: BOOL = 0;
    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

    const PROCESS_TERMINATE: DWORD = 0x0001;
    const PROCESS_SET_QUOTA: DWORD = 0x0100;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x00002000;
    const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: DWORD = 0x00000400;

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct JobobjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: DWORD,
        minimum_working_set_size: SIZE_T,
        maximum_working_set_size: SIZE_T,
        active_process_limit: DWORD,
        affinity: ULONG_PTR,
        priority_class: DWORD,
        scheduling_class: DWORD,
    }

    #[repr(C)]
    struct JobobjectExtendedLimitInformation {
        basic_limit_information: JobobjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: SIZE_T,
        job_memory_limit: SIZE_T,
        peak_process_memory_limit: SIZE_T,
        peak_job_memory_limit: SIZE_T,
    }

    extern "system" {
        fn CreateJobObjectW(
            lp_job_attributes: *const c_void,
            lp_name: *const u16,
        ) -> HANDLE;

        fn SetInformationJobObject(
            h_job: HANDLE,
            job_object_info_class: u32,
            lp_job_object_info: *const c_void,
            cb_job_object_info_length: DWORD,
        ) -> BOOL;

        fn AssignProcessToJobObject(
            h_job: HANDLE,
            h_process: HANDLE,
        ) -> BOOL;

        fn OpenProcess(
            dw_desired_access: DWORD,
            b_inherit_handle: BOOL,
            dw_process_id: DWORD,
        ) -> HANDLE;

        fn TerminateJobObject(
            h_job: HANDLE,
            u_exit_code: u32,
        ) -> BOOL;

        fn CloseHandle(
            h_object: HANDLE,
        ) -> BOOL;

        fn GetLastError() -> DWORD;
    }

    static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
    static JOBS: Mutex<Option<HashMap<i64, usize>>> = Mutex::new(None);

    fn with_jobs<F, R>(f: F) -> R
    where
        F: FnOnce(&mut HashMap<i64, usize>) -> R,
    {
        let mut lock = JOBS.lock().unwrap();
        if lock.is_none() {
            *lock = Some(HashMap::new());
        }
        f(lock.as_mut().unwrap())
    }

    pub fn create_job() -> Result<i64, String> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(format!("CreateJobObjectW failed with err: {}", unsafe { GetLastError() }));
        }

        let mut info: JobobjectExtendedLimitInformation = unsafe { std::mem::zeroed() };
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        let set_res = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JobobjectExtendedLimitInformation>() as DWORD,
            )
        };

        if set_res == 0 {
            let err = unsafe { GetLastError() };
            unsafe { CloseHandle(handle) };
            return Err(format!("SetInformationJobObject failed with err: {}", err));
        }

        let id = NEXT_JOB_ID.fetch_add(1, Ordering::SeqCst) as i64;
        with_jobs(|jobs| {
            jobs.insert(id, handle as usize);
        });
        Ok(id)
    }

    pub fn assign_process(job_id: i64, pid: u32) -> Result<bool, String> {
        let handle = with_jobs(|jobs| jobs.get(&job_id).copied())
            .ok_or_else(|| format!("Job ID {} not found", job_id))? as HANDLE;

        let proc_handle = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid) };
        if proc_handle.is_null() || proc_handle == INVALID_HANDLE_VALUE {
            return Err(format!("OpenProcess({}) failed with err: {}", pid, unsafe { GetLastError() }));
        }

        let assign_res = unsafe { AssignProcessToJobObject(handle, proc_handle) };
        let err = if assign_res == 0 { unsafe { GetLastError() } } else { 0 };
        unsafe { CloseHandle(proc_handle) };

        if assign_res == 0 {
            return Err(format!("AssignProcessToJobObject failed with err: {}", err));
        }
        Ok(true)
    }

    pub fn terminate_job(job_id: i64, exit_code: u32) -> Result<bool, String> {
        let handle = with_jobs(|jobs| jobs.get(&job_id).copied())
            .ok_or_else(|| format!("Job ID {} not found", job_id))? as HANDLE;

        let res = unsafe { TerminateJobObject(handle, exit_code) };
        if res == 0 {
            return Err(format!("TerminateJobObject failed with err: {}", unsafe { GetLastError() }));
        }
        Ok(true)
    }

    pub fn close_job(job_id: i64) -> Result<bool, String> {
        let handle = with_jobs(|jobs| jobs.remove(&job_id))
            .ok_or_else(|| format!("Job ID {} not found", job_id))? as HANDLE;

        let res = unsafe { CloseHandle(handle) };
        if res == 0 {
            return Err(format!("CloseHandle failed with err: {}", unsafe { GetLastError() }));
        }
        Ok(true)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn create_job() -> Result<i64, String> {
        Ok(1)
    }

    pub fn assign_process(_job_id: i64, _pid: u32) -> Result<bool, String> {
        Ok(true)
    }

    pub fn terminate_job(_job_id: i64, _exit_code: u32) -> Result<bool, String> {
        Ok(true)
    }

    pub fn close_job(_job_id: i64) -> Result<bool, String> {
        Ok(true)
    }
}

pub use imp::*;
