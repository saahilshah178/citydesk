/** Open311 GeoReport v2 types, normalized so every city looks the same to callers. */

export interface Service {
  service_code: string;
  service_name: string;
  description?: string;
  /** True when the service has a definition with attributes to fill in. */
  metadata: boolean;
  type?: string;
  keywords?: string;
  group?: string;
  /** Agency or organization that owns the service, when the server reports it (SeeClickFix does). */
  organization?: string;
}

export interface ServiceAttributeValue {
  key: string;
  name: string;
}

export interface ServiceAttribute {
  code: string;
  description: string;
  datatype: string;
  required: boolean;
  variable: boolean;
  order?: number;
  datatype_description?: string;
  values: ServiceAttributeValue[];
}

export interface ServiceDefinition {
  service_code: string;
  attributes: ServiceAttribute[];
}

export type RequestStatus = 'open' | 'closed';

export interface ServiceRequest {
  /** Always a string, even where the city uses numbers. */
  service_request_id: string;
  status: RequestStatus;
  /** The status string exactly as the server sent it, when it was not plain "open" or "closed". */
  status_raw?: string;
  status_notes?: string;
  service_name?: string;
  service_code?: string;
  description?: string;
  agency_responsible?: string;
  service_notice?: string;
  /** ISO 8601 in UTC. */
  requested_datetime: string;
  updated_datetime?: string;
  expected_datetime?: string;
  address?: string;
  address_id?: string;
  zipcode?: string;
  lat?: number;
  long?: number;
  media_url?: string;
  token?: string;
  extended_attributes?: Record<string, unknown>;
}

/** [minLongitude, minLatitude, maxLongitude, maxLatitude] */
export type BoundingBox = readonly [number, number, number, number];

export interface SearchRequestsOptions {
  serviceCode?: string;
  status?: RequestStatus;
  /** Inclusive lower bound on requested_datetime. */
  startDate?: Date;
  /** Inclusive upper bound on requested_datetime. */
  endDate?: Date;
  /** Keep only requests inside this box. Applied in the client when the server cannot filter by area. */
  bbox?: BoundingBox;
  /** Keep only requests within radiusMeters of a point. Applied in the client. */
  near?: { lat: number; long: number; radiusMeters: number };
  /** Free text, for servers that support `q`. */
  query?: string;
  /** Stop after this many matching requests. Default 300. */
  limit?: number;
  /** Stop after this many pages per date window. Default 10. */
  maxPages?: number;
  /** Ask for `extensions=true` where supported. */
  extensions?: boolean;
}

export interface CreateRequestInput {
  serviceCode: string;
  description?: string;
  lat?: number;
  long?: number;
  addressString?: string;
  addressId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mediaUrl?: string;
  deviceId?: string;
  /** Service definition answers: attribute code to a value, or values for multi-value lists. */
  attributes?: Record<string, string | string[]>;
}

export interface CreateRequestResult {
  /** Present when the server assigned an ID right away. */
  service_request_id?: string;
  /** Present when the server will assign the ID later (look it up with getRequestIdFromToken). */
  token?: string;
  service_notice?: string;
  account_id?: string;
}
