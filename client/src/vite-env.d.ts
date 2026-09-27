/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API. Defaults to `/api`, which the dev server proxies. */
  readonly VITE_API_BASE_URL?: string;
  /** Solana cluster the application reads from: devnet | testnet | mainnet-beta | localnet. */
  readonly VITE_SOLANA_NETWORK?: string;
  /** Optional read-only RPC endpoint. Empty means "use the cluster default". */
  readonly VITE_SOLANA_RPC_URL?: string;
  /** Deployed address of the on-chain supply chain program. */
  readonly VITE_SOLANA_PROGRAM_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
