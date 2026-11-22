//! Four f32 lanes: `core::arch::wasm32` SIMD128 intrinsics on wasm, a plain `[f32; 4]` elsewhere. Same API and
//! the same IEEE single-precision operations in the same order (no FMA), so the native build is a bit-exact
//! oracle for the wasm kernel. `no_std`: the size stub compiles this file on its own.

#[cfg(target_arch = "wasm32")]
mod imp {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct V4(v128);

    impl V4 {
        /// # Safety
        /// `index + 4 <= slice.len()`.
        #[inline(always)]
        pub unsafe fn load(slice: &[f32], index: usize) -> Self {
            debug_assert!(index + 4 <= slice.len());
            // `v128.load` has no alignment requirement; the pointer is only as aligned as an f32.
            V4(v128_load(slice.as_ptr().add(index) as *const v128))
        }

        /// # Safety
        /// `index + 4 <= slice.len()`.
        #[inline(always)]
        pub unsafe fn store(self, slice: &mut [f32], index: usize) {
            debug_assert!(index + 4 <= slice.len());
            v128_store(slice.as_mut_ptr().add(index) as *mut v128, self.0)
        }

        #[inline(always)]
        pub fn splat(value: f32) -> Self {
            V4(f32x4_splat(value))
        }

        #[inline(always)]
        pub fn add(self, other: Self) -> Self {
            V4(f32x4_add(self.0, other.0))
        }

        #[inline(always)]
        pub fn sub(self, other: Self) -> Self {
            V4(f32x4_sub(self.0, other.0))
        }

        #[inline(always)]
        pub fn mul(self, other: Self) -> Self {
            V4(f32x4_mul(self.0, other.0))
        }

        /// Lanes picked from `self` (indices 0–3) and `other` (4–7), as `i32x4.shuffle` does.
        #[inline(always)]
        pub fn shuffle<const A: usize, const B: usize, const C: usize, const D: usize>(self, other: Self) -> Self {
            V4(i32x4_shuffle::<A, B, C, D>(self.0, other.0))
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    #[derive(Clone, Copy)]
    pub struct V4([f32; 4]);

    impl V4 {
        /// # Safety
        /// `index + 4 <= slice.len()`.
        #[inline(always)]
        pub unsafe fn load(slice: &[f32], index: usize) -> Self {
            debug_assert!(index + 4 <= slice.len());
            V4(slice.as_ptr().add(index).cast::<[f32; 4]>().read_unaligned())
        }

        /// # Safety
        /// `index + 4 <= slice.len()`.
        #[inline(always)]
        pub unsafe fn store(self, slice: &mut [f32], index: usize) {
            debug_assert!(index + 4 <= slice.len());
            slice.as_mut_ptr().add(index).cast::<[f32; 4]>().write_unaligned(self.0)
        }

        #[inline(always)]
        pub fn splat(value: f32) -> Self {
            V4([value; 4])
        }

        #[inline(always)]
        pub fn add(self, other: Self) -> Self {
            V4(core::array::from_fn(|lane| self.0[lane] + other.0[lane]))
        }

        #[inline(always)]
        pub fn sub(self, other: Self) -> Self {
            V4(core::array::from_fn(|lane| self.0[lane] - other.0[lane]))
        }

        #[inline(always)]
        pub fn mul(self, other: Self) -> Self {
            V4(core::array::from_fn(|lane| self.0[lane] * other.0[lane]))
        }

        #[inline(always)]
        pub fn shuffle<const A: usize, const B: usize, const C: usize, const D: usize>(self, other: Self) -> Self {
            let pick = |index: usize| if index < 4 { self.0[index] } else { other.0[index - 4] };
            V4([pick(A), pick(B), pick(C), pick(D)])
        }
    }
}

pub use imp::V4;

impl V4 {
    /// Lanes 3, 2, 1, 0.
    #[inline(always)]
    pub fn reverse(self) -> Self {
        self.shuffle::<3, 2, 1, 0>(self)
    }
}
