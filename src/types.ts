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
  nextCheckAt: string;
  lastError: string | null;
  createdAt: string;
  newListingsCount: number;
}
