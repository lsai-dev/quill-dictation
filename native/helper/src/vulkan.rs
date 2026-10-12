//! Detects whether a Vulkan loader is installed (i.e. whether the Vulkan build of the
//! engine can start). This only proves the loader exists; the engine itself reports
//! whether a usable device is present when it loads a model.

/// Loads and immediately unloads the platform's Vulkan loader library.
pub fn available() -> bool {
    match load() {
        Ok(()) => true,
        Err(e) => {
            crate::protocol::log!("vulkan loader not available: {e}");
            false
        }
    }
}

const ENTRY_POINT: &[u8] = b"vkGetInstanceProcAddr\0";

#[cfg(windows)]
fn load() -> Result<(), libloading::Error> {
    use libloading::os::windows::{Library, LOAD_LIBRARY_SEARCH_SYSTEM32};
    // Only System32: never pick up a stray vulkan-1.dll from the working directory.
    // SAFETY: loading the system Vulkan loader runs only its benign DllMain.
    let lib = unsafe { Library::load_with_flags("vulkan-1.dll", LOAD_LIBRARY_SEARCH_SYSTEM32)? };
    // SAFETY: the symbol is only looked up, never called.
    unsafe { lib.get::<unsafe extern "system" fn()>(ENTRY_POINT)? };
    lib.close()
}

#[cfg(not(windows))]
fn load() -> Result<(), libloading::Error> {
    let name = if cfg!(target_os = "macos") { "libvulkan.1.dylib" } else { "libvulkan.so.1" };
    // SAFETY: loading the Vulkan loader runs only its library constructors.
    let lib = unsafe { libloading::Library::new(name)? };
    // SAFETY: the symbol is only looked up, never called.
    unsafe { lib.get::<unsafe extern "C" fn()>(ENTRY_POINT)? };
    lib.close()
}
