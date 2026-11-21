// The plan's gate "no allocation after plan creation" (the engine's talc rule: never allocate during
// render). A counting allocator wraps the system allocator for this test binary only; every option's
// `forward` and `inverse` must leave the count untouched. `new` may allocate and is not counted.
// No warm-up call on purpose: an option that allocates lazily on its first call must fail too.

use fft_bench::options::ALL;
use fft_bench::signals::Signal;
use fft_bench::{bins, SIZES};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::hint::black_box;

struct CountingAllocator;

thread_local! {
    // Per thread, because the test harness runs tests on parallel threads.
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

fn count() {
    // `try_with`: thread-local storage may already be gone while a thread shuts down.
    let _ = ALLOCATIONS.try_with(|allocations| allocations.set(allocations.get() + 1));
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        System.alloc_zeroed(layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        System.realloc(pointer, layout, new_size)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations_during(action: impl FnOnce()) -> usize {
    let before = ALLOCATIONS.with(Cell::get);
    action();
    ALLOCATIONS.with(Cell::get) - before
}

#[test]
fn the_counter_sees_an_allocation() {
    // black_box keeps the optimiser (tests build at opt-level 3) from removing the unused vector.
    assert_eq!(allocations_during(|| drop(black_box(vec![0u8; 16]))), 1);
    assert_eq!(allocations_during(|| {}), 0);
}

#[test]
fn no_option_allocates_after_plan_creation() {
    for n in SIZES {
        let input = Signal::WhiteNoise.generate(n);
        let (mut re, mut im, mut output) = (vec![0.0; bins(n)], vec![0.0; bins(n)], vec![0.0; n]);
        for entry in ALL.iter() {
            let mut fft = (entry.create)(n);
            let forward = allocations_during(|| fft.forward(&input, &mut re, &mut im));
            let inverse = allocations_during(|| {
                fft.inverse(&re, &im, &mut output);
            });
            assert_eq!((forward, inverse), (0, 0), "{}, n = {n}: allocations in (forward, inverse)", entry.name);
        }
    }
}
