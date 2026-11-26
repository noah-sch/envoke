import { AsyncEntry } from "@napi-rs/keyring";

/** Secrets (API keys, OAuth records). Never written to the config file, the database or logs. */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** OS keychain: macOS Keychain, Secret Service on Linux. */
export class KeychainStore implements CredentialStore {
  readonly #service: string;

  constructor(service = "envoke") {
    this.#service = service;
  }

  async get(key: string): Promise<string | null> {
    return new AsyncEntry(this.#service, key).getPassword();
  }

  async set(key: string, value: string): Promise<void> {
    await new AsyncEntry(this.#service, key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    await new AsyncEntry(this.#service, key).deletePassword();
  }
}

export class MemoryStore implements CredentialStore {
  readonly #values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
}

export const secretKey = (connectionId: string): string => `secret:${connectionId}`;
