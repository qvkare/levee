//! Strict EVM address handling.
//!
//! An address is `0x` followed by exactly 40 hex characters. A registered
//! borrower can never change, so a typo here would be permanent. The zero address
//! is refused for the same reason: value sent to it is burnt.

pub type Address = [u8; 20];

pub const ERR_ADDRESS_FORMAT: &str = "address must be 0x followed by 40 hex characters";
pub const ERR_ZERO_ADDRESS: &str = "the zero address is not allowed";

/// Parses a strict address into its 20 bytes.
pub fn parse_address(value: &str) -> Result<Address, &'static str> {
    let digits = value.strip_prefix("0x").ok_or(ERR_ADDRESS_FORMAT)?;
    let mut address = [0u8; 20];
    hex::decode_to_slice(digits, &mut address).map_err(|_| ERR_ADDRESS_FORMAT)?;
    if address == [0u8; 20] {
        return Err(ERR_ZERO_ADDRESS);
    }
    Ok(address)
}

/// Validates an address and returns its stored form: lowercase with the prefix.
pub fn normalise_address(value: &str) -> Result<String, &'static str> {
    parse_address(value).map(|address| format!("0x{}", hex::encode(address)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOWER: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const CHECKSUMMED: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const UPPER: &str = "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913";

    #[test]
    fn parses_the_exact_bytes() {
        let address = parse_address(LOWER).unwrap();
        assert_eq!(address[0], 0x83);
        assert_eq!(address[19], 0x13);
    }

    #[test]
    fn every_case_normalises_to_lowercase() {
        assert_eq!(normalise_address(LOWER).unwrap(), LOWER);
        assert_eq!(normalise_address(CHECKSUMMED).unwrap(), LOWER);
        assert_eq!(normalise_address(UPPER).unwrap(), LOWER);
    }

    #[test]
    fn normalising_is_idempotent() {
        let once = normalise_address(CHECKSUMMED).unwrap();
        assert_eq!(normalise_address(&once).unwrap(), once);
    }

    #[test]
    fn rejects_a_missing_prefix() {
        let bare = &LOWER[2..];
        assert_eq!(parse_address(bare), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_an_uppercase_prefix() {
        let value = LOWER.replacen("0x", "0X", 1);
        assert_eq!(parse_address(&value), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_39_and_41_digits() {
        assert_eq!(parse_address(&LOWER[..41]), Err(ERR_ADDRESS_FORMAT));
        let long = format!("{LOWER}0");
        assert_eq!(parse_address(&long), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_a_non_hex_digit() {
        let value = format!("{}g", &LOWER[..41]);
        assert_eq!(parse_address(&value), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_surrounding_whitespace() {
        assert_eq!(parse_address(&format!(" {LOWER}")), Err(ERR_ADDRESS_FORMAT));
        assert_eq!(parse_address(&format!("{LOWER} ")), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_multibyte_characters_of_the_right_byte_length() {
        // Forty bytes, twenty characters: a length check on bytes alone would pass.
        let value = format!("0x{}", "é".repeat(20));
        assert_eq!(value.len(), 42);
        assert_eq!(parse_address(&value), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_an_empty_string() {
        assert_eq!(parse_address(""), Err(ERR_ADDRESS_FORMAT));
        assert_eq!(parse_address("0x"), Err(ERR_ADDRESS_FORMAT));
    }

    #[test]
    fn rejects_the_zero_address() {
        let zero = format!("0x{}", "0".repeat(40));
        assert_eq!(parse_address(&zero), Err(ERR_ZERO_ADDRESS));
    }

    #[test]
    fn accepts_the_smallest_non_zero_address() {
        let one = format!("0x{}1", "0".repeat(39));
        assert_eq!(parse_address(&one).unwrap()[19], 1);
    }
}
