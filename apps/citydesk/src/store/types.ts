/** Per-user memory: the requests a resident filed or follows, and the home address they last asked about. */

export interface TrackedRequest {
  /** "<endpoint id>/<service_request_id>", the handle tools hand out. */
  request_id: string;
  endpoint_id: string;
  service_request_id: string;
  relation: 'filed' | 'followed';
  /** ISO 8601. When the user filed or started following it. */
  since: string;
  service_name?: string;
  address?: string;
  /** What the request looked like the last time we checked, so changes can be called out. */
  last_status?: 'open' | 'closed';
  last_status_notes?: string;
  last_checked?: string;
}

export interface HomeAddress {
  address_id: string;
  address: string;
  neighborhood?: string;
  zip_code?: string;
  /** ISO 8601. */
  saved_at: string;
}

export interface UserStore {
  /** Adds or updates a tracked request. A request the user filed is never downgraded to "followed". */
  track(userId: string, request: TrackedRequest): Promise<TrackedRequest>;
  /** Newest first. */
  list(userId: string): Promise<TrackedRequest[]>;
  get(userId: string, requestId: string): Promise<TrackedRequest | undefined>;
  /** Records the latest status seen for a tracked request. No-op when the request is not tracked. */
  snapshot(
    userId: string,
    requestId: string,
    seen: { status: 'open' | 'closed'; status_notes?: string; checked: string },
  ): Promise<void>;
  getHomeAddress(userId: string): Promise<HomeAddress | undefined>;
  setHomeAddress(userId: string, home: HomeAddress): Promise<void>;
  /**
   * Adds one to a named counter and returns the new value. Counters expire `ttlSeconds` after their
   * first increment. Used to cap how many reports one household, and the whole demo, can file per hour.
   */
  increment(counter: string, ttlSeconds: number): Promise<number>;
}
