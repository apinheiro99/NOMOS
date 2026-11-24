import { sanitizeResponse } from "./sanitize.js";
import { safeApiError } from "./errors.js";

export class TaigaClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private authToken: string | null = null;
  private refreshToken: string | null = null;
  private username_: string | null = null;

  constructor() {
    const url = process.env.TAIGA_URL;
    const username = process.env.TAIGA_USERNAME;
    const password = process.env.TAIGA_PASSWORD;

    if (!url || !username || !password) {
      throw new Error(
        "Missing required environment variables: TAIGA_URL, TAIGA_USERNAME, TAIGA_PASSWORD",
      );
    }

    this.baseUrl = url.replace(/\/+$/, "");
    if (!this.baseUrl.includes("/api/v1")) {
      this.baseUrl += "/api/v1";
    }
    this.username = username;
    this.password = password;
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "normal",
        username: this.username,
        password: this.password,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw safeApiError(`Taiga auth failed (${res.status})`, text);
    }

    const data = await res.json();
    this.authToken = data.auth_token;
    this.refreshToken = data.refresh ?? null;
    this.username_ = null;
  }

  private async refreshAuth(): Promise<boolean> {
    if (!this.refreshToken) return false;

    try {
      const res = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: this.refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      this.authToken = data.auth_token;
      this.refreshToken = data.refresh ?? this.refreshToken;
      return true;
    } catch {
      return false;
    }
  }

  private async ensureAuth(): Promise<void> {
    if (!this.authToken) {
      await this.login();
    }
  }

  private async headers(): Promise<Record<string, string>> {
    await this.ensureAuth();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.authToken}`,
    };
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          if (Array.isArray(value)) {
            url.searchParams.set(key, value.join(","));
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      }
    }
    return url.toString();
  }

  private async request(
    method: string,
    path: string,
    options?: {
      params?: Record<string, unknown>;
      body?: unknown;
      isMultipart?: boolean;
      allPages?: boolean;
      keep?: readonly string[];
    },
  ): Promise<unknown> {
    const doRequest = async (): Promise<Response> => {
      const hdrs = await this.headers();
      if (options?.allPages) hdrs["x-disable-pagination"] = "True";

      const fetchOptions: RequestInit = { method, headers: hdrs };

      if (options?.body && !options?.isMultipart) {
        fetchOptions.body = JSON.stringify(options.body);
      } else if (options?.isMultipart && options.body instanceof FormData) {
        delete (hdrs as Record<string, string>)["Content-Type"];
        fetchOptions.headers = hdrs;
        fetchOptions.body = options.body as FormData;
      }

      const url = this.buildUrl(path, options?.params);
      return fetch(url, fetchOptions);
    };

    let res = await doRequest();

    // Auto-refresh on 401
    if (res.status === 401) {
      const refreshed = await this.refreshAuth();
      if (!refreshed) {
        await this.login();
      }
      res = await doRequest();
    }

    if (res.status === 204) {
      return null;
    }

    if (!res.ok) {
      const text = await res.text();
      throw safeApiError(`Taiga API error ${res.status} ${method} ${path}`, text);
    }

    // Some Taiga actions (e.g. delete_comment) answer 200 with an empty body.
    const raw = await res.text();
    return raw ? sanitizeResponse(JSON.parse(raw), options?.keep) : null;
  }

  // The Taiga account this session really belongs to (GET /users/me), read once per login so a new login is always re-verified.
  async authenticatedUsername(): Promise<string> {
    this.username_ ??= ((await this.get("/users/me")) as { username: string }).username;
    return this.username_;
  }

  async get(path: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request("GET", path, { params });
  }

  // An internal read that needs hidden position keys (only taiga_userstory_move_to_backlog reads backlog_order); never returned to callers.
  async getKeeping(keep: readonly string[], path: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request("GET", path, { params, keep });
  }

  // Every row of a list endpoint in ONE response (Taiga's x-disable-pagination): callers that must be exhaustive (identity scans) never
  // depend on a page size or on guessing the last page.
  async getAll(path: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request("GET", path, { params, allPages: true });
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.request("POST", path, { body });
  }

  async put(path: string, body?: unknown): Promise<unknown> {
    return this.request("PUT", path, { body });
  }

  async patch(path: string, body?: unknown): Promise<unknown> {
    return this.request("PATCH", path, { body });
  }

  async delete(path: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request("DELETE", path, { params });
  }

  async postMultipart(path: string, formData: FormData): Promise<unknown> {
    return this.request("POST", path, { body: formData, isMultipart: true });
  }
}
