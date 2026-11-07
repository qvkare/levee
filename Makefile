.PHONY: verify

# Spec section 6. Needs `pnpm install` and no keys.
verify:
	pnpm --silent --filter keeper keeper verify
