// The part of crates/signalsmith/src/simd.rs at 7998a6b64 that the reverted fft.rs uses, lines verbatim.

//! A 4-lane f32 SIMD abstraction: a wasm `v128` implementation and a scalar `[f32;4]` fallback behind one API,
//! so the hot per-band loops are written ONCE. Because wasm `f32x4` arithmetic is the same IEEE-754 single as
//! scalar `f32` (no FMA on these paths), the fallback compiled natively is a bit-exact oracle for the wasm
//! intrinsics — the crate's native tests validate the SIMD algorithm directly.

#[cfg(target_arch = "wasm32")]
mod imp {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    pub struct Simd4(pub(super) v128);

    impl Simd4 {
        #[inline] pub fn load(slice: &[f32]) -> Self { Simd4(f32x4(slice[0], slice[1], slice[2], slice[3])) }
        #[inline] pub fn store(self, slice: &mut [f32]) {
            slice[0] = f32x4_extract_lane::<0>(self.0); slice[1] = f32x4_extract_lane::<1>(self.0);
            slice[2] = f32x4_extract_lane::<2>(self.0); slice[3] = f32x4_extract_lane::<3>(self.0);
        }
        #[inline] pub fn add(self, o: Self) -> Self { Simd4(f32x4_add(self.0, o.0)) }
        #[inline] pub fn sub(self, o: Self) -> Self { Simd4(f32x4_sub(self.0, o.0)) }
        #[inline] pub fn mul(self, o: Self) -> Self { Simd4(f32x4_mul(self.0, o.0)) }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    #[derive(Clone, Copy)]
    pub struct Simd4(pub(super) [f32; 4]);

    #[inline] fn map2(a: [f32; 4], b: [f32; 4], f: impl Fn(f32, f32) -> f32) -> [f32; 4] {
        [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2]), f(a[3], b[3])]
    }

    impl Simd4 {
        #[inline] pub fn load(slice: &[f32]) -> Self { Simd4([slice[0], slice[1], slice[2], slice[3]]) }
        #[inline] pub fn store(self, slice: &mut [f32]) { slice[..4].copy_from_slice(&self.0); }
        #[inline] pub fn add(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x + y)) }
        #[inline] pub fn sub(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x - y)) }
        #[inline] pub fn mul(self, o: Self) -> Self { Simd4(map2(self.0, o.0, |x, y| x * y)) }
    }
}

pub use imp::Simd4;
