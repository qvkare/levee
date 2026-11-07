//! The part of RLP an EIP-1559 transaction needs.
//!
//! Encoding only. The contract never reads RLP back, so a decoder would be code
//! that runs nowhere. Integers are `u128` because no field Levee signs is wider.

const STRING_OFFSET: u8 = 0x80;
const LIST_OFFSET: u8 = 0xc0;
/// Payloads shorter than this carry their length in the first byte.
const SHORT_PAYLOAD_LIMIT: usize = 56;

/// Appends `bytes` as an RLP string.
pub fn encode_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    if let [byte] = bytes {
        if *byte < STRING_OFFSET {
            out.push(*byte);
            return;
        }
    }
    encode_header(out, STRING_OFFSET, bytes.len());
    out.extend_from_slice(bytes);
}

/// Appends `value` as an RLP integer: big endian, no leading zeros, and zero is
/// the empty string.
pub fn encode_uint(out: &mut Vec<u8>, value: u128) {
    let bytes = value.to_be_bytes();
    encode_bytes(out, strip_leading_zeros(&bytes));
}

/// Appends a list whose items are already encoded in `payload`.
pub fn encode_list(out: &mut Vec<u8>, payload: &[u8]) {
    encode_header(out, LIST_OFFSET, payload.len());
    out.extend_from_slice(payload);
}

fn encode_header(out: &mut Vec<u8>, offset: u8, len: usize) {
    if len < SHORT_PAYLOAD_LIMIT {
        out.push(offset + len as u8);
        return;
    }
    let bytes = (len as u64).to_be_bytes();
    let len_bytes = strip_leading_zeros(&bytes);
    out.push(offset + 55 + len_bytes.len() as u8);
    out.extend_from_slice(len_bytes);
}

fn strip_leading_zeros(bytes: &[u8]) -> &[u8] {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[first..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(input: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        encode_bytes(&mut out, input);
        out
    }

    fn uint(input: u128) -> Vec<u8> {
        let mut out = Vec::new();
        encode_uint(&mut out, input);
        out
    }

    fn list(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        encode_list(&mut out, payload);
        out
    }

    #[test]
    fn empty_string_is_0x80() {
        assert_eq!(bytes(&[]), [0x80]);
    }

    #[test]
    fn single_byte_below_0x80_is_itself() {
        assert_eq!(bytes(&[0x00]), [0x00]);
        assert_eq!(bytes(&[0x0f]), [0x0f]);
        assert_eq!(bytes(&[0x7f]), [0x7f]);
    }

    #[test]
    fn single_byte_from_0x80_gets_a_header() {
        assert_eq!(bytes(&[0x80]), [0x81, 0x80]);
        assert_eq!(bytes(&[0xff]), [0x81, 0xff]);
    }

    #[test]
    fn dog_encodes_as_in_the_rlp_spec() {
        assert_eq!(bytes(b"dog"), [0x83, b'd', b'o', b'g']);
    }

    #[test]
    fn string_of_55_bytes_keeps_the_short_form() {
        let input = [0xaa; 55];
        let out = bytes(&input);
        assert_eq!(out[0], 0x80 + 55);
        assert_eq!(&out[1..], input);
    }

    #[test]
    fn string_of_56_bytes_moves_to_the_long_form() {
        let input = [0xaa; 56];
        let out = bytes(&input);
        assert_eq!(&out[..2], [0xb8, 56]);
        assert_eq!(&out[2..], input);
    }

    #[test]
    fn long_length_is_big_endian_with_no_leading_zeros() {
        let input = vec![0xaa; 1024];
        let out = bytes(&input);
        assert_eq!(&out[..3], [0xb9, 0x04, 0x00]);
        assert_eq!(out.len(), 3 + 1024);
    }

    #[test]
    fn zero_is_the_empty_string() {
        assert_eq!(uint(0), [0x80]);
    }

    #[test]
    fn integers_drop_leading_zeros() {
        assert_eq!(uint(1), [0x01]);
        assert_eq!(uint(0x7f), [0x7f]);
        assert_eq!(uint(0x80), [0x81, 0x80]);
        assert_eq!(uint(0x0400), [0x82, 0x04, 0x00]);
        assert_eq!(uint(0x0100_0000), [0x84, 0x01, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn largest_u128_uses_all_sixteen_bytes() {
        let out = uint(u128::MAX);
        assert_eq!(out[0], 0x80 + 16);
        assert_eq!(&out[1..], [0xff; 16]);
    }

    #[test]
    fn empty_list_is_0xc0() {
        assert_eq!(list(&[]), [0xc0]);
    }

    #[test]
    fn cat_dog_list_encodes_as_in_the_rlp_spec() {
        let mut payload = Vec::new();
        encode_bytes(&mut payload, b"cat");
        encode_bytes(&mut payload, b"dog");
        assert_eq!(
            list(&payload),
            [0xc8, 0x83, b'c', b'a', b't', 0x83, b'd', b'o', b'g']
        );
    }

    #[test]
    fn list_of_55_bytes_keeps_the_short_form() {
        let payload = [0x01; 55];
        assert_eq!(list(&payload)[0], 0xc0 + 55);
    }

    #[test]
    fn list_of_56_bytes_moves_to_the_long_form() {
        let payload = [0x01; 56];
        assert_eq!(&list(&payload)[..2], [0xf8, 56]);
    }

    #[test]
    fn list_of_256_bytes_uses_a_two_byte_length() {
        let payload = [0x01; 256];
        assert_eq!(&list(&payload)[..3], [0xf9, 0x01, 0x00]);
    }
}
