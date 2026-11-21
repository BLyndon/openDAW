//! What the engine provides around its DSP code, in the smallest form: `no_std`, a global allocator (the
//! engine's is talc) and a panic handler. Every `no_std` stub links this crate, and the `empty` stub is
//! nothing else, so a size delta measures only what an option adds. A dependency that needs `std` brings
//! its own panic handler and cannot link against this one, exactly as it could not in the engine.
//! The stubs are only built, never run, so the allocator only has to be valid, not good.
#![no_std]

use core::alloc::{GlobalAlloc, Layout};
use core::ptr::{addr_of_mut, null_mut};

const ARENA: usize = 4 * 1024 * 1024;
static mut MEMORY: [u8; ARENA] = [0; ARENA];
static mut OFFSET: usize = 0;

/// Hands out memory from a fixed arena and never frees it.
struct Bump;

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // Round the offset up to the alignment (a power of two), then reserve the size.
        let start = (OFFSET + layout.align() - 1) & !(layout.align() - 1);
        if start + layout.size() > ARENA {
            return null_mut();
        }
        OFFSET = start + layout.size();
        addr_of_mut!(MEMORY).cast::<u8>().add(start)
    }

    unsafe fn dealloc(&self, _pointer: *mut u8, _layout: Layout) {}
}

#[global_allocator]
static ALLOCATOR: Bump = Bump;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
