#[cfg(all(not(feature = "polkadot-ahm"), feature = "on-chain-release-build"))]
compile_error!("Asset Hub migration requires the `polkadot-ahm` feature");

// Polkadot version identifier;
/// Runtime version (Polkadot).
#[sp_version::runtime_version]
pub const VERSION: RuntimeVersion = RuntimeVersion {
	spec_name: alloc::borrow::Cow::Borrowed("polkadot"),
	impl_name: alloc::borrow::Cow::Borrowed("parity-polkadot"),
	authoring_version: 0,
	spec_version: 2_005_001,
	impl_version: 0,
	apis: RUNTIME_API_VERSIONS,
	transaction_version: 26,
	system_version: 1,
};

