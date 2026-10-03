export interface Listing {
  externalId: string;
  title: string;
  url: string;
  price: string | null;
  imageUrl: string | null;
}

export interface Monitor {
  id: number;
  name: string;
  url: string;
  intervalMinutes: number;
  enabled: number;
  initialized: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  newListingsCount: number;
  lastCheckNewCount: number;
  currentListingsCount: number;
  excludedListingsCount: number;
  activeClientsCount: number;
}

export interface MonitorExclusion {
  monitorId: number;
  externalId: string;
  title: string;
  createdAt: string;
}

export interface DeviceInfo {
  extensionVersion: string | null;
  browser: string | null;
  os: string | null;
  osVersion: string | null;
  arch: string | null;
}

export interface ExtensionClient extends DeviceInfo {
  id: number;
  name: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  active: number;
  openMonitorsCount: number;
}
