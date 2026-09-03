/** The transport surface the client needs — one method, so tests can fake it. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface FetchInit {
  method: HttpMethod;
  /** Path under the MyChart app root, e.g. `api/allergies/LoadAllergies`. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResult {
  status: number;
  body: string;
  url?: string;
}

export interface MahTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  fetch(init: FetchInit): Promise<FetchResult>;
}
