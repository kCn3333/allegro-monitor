import os
import sys
import logging
from typing import Any, Dict, Optional

import requests
from requests.auth import HTTPBasicAuth

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Read defaults from environment (do NOT hardcode secrets here)
CLIENT_ID = os.getenv("ALLEGRO_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("ALLEGRO_CLIENT_SECRET", "")
TOKEN_URL = os.getenv("ALLEGRO_TOKEN_URL", "https://allegro.pl.allegrosandbox.pl/auth/oauth/token")
CATEGORIES_URL = os.getenv("ALLEGRO_CATEGORIES_URL", "https://api.allegro.pl.allegrosandbox.pl/sale/categories")


def get_access_token(
    client_id: str,
    client_secret: str,
    token_url: str = TOKEN_URL,
    timeout: int = 10,
    verify: Optional[Any] = True,
) -> str:
    """
    Obtain an OAuth client_credentials access token from Allegro sandbox.
    """
    if not client_id or not client_secret:
        raise RuntimeError("CLIENT_ID and CLIENT_SECRET must be provided (env ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET).")

    data = {"grant_type": "client_credentials"}
    auth = HTTPBasicAuth(client_id, client_secret)

    try:
        resp = requests.post(token_url, data=data, auth=auth, timeout=timeout, verify=verify)
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        logger.error("Failed to request access token: %s", e)
        raise RuntimeError(f"Token request failed: {e}") from e

    try:
        payload = resp.json()
    except ValueError:
        logger.error("Token endpoint did not return valid JSON: %s", resp.text)
        raise RuntimeError("Token endpoint returned invalid JSON")

    access_token = payload.get("access_token")
    if not access_token:
        logger.error("Token response missing access_token: %s", payload)
        raise RuntimeError("Token response did not contain access_token")

    return access_token


def get_main_categories(
    access_token: str,
    categories_url: str = CATEGORIES_URL,
    timeout: int = 10,
    verify: Optional[Any] = True,
) -> Dict[str, Any]:
    """
    Retrieve main categories from Allegro sandbox API.
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.allegro.public.v1+json",
    }

    try:
        resp = requests.get(categories_url, headers=headers, timeout=timeout, verify=verify)
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        logger.error("Failed to fetch categories: %s", e)
        raise RuntimeError(f"Categories request failed: {e}") from e

    try:
        return resp.json()
    except ValueError:
        logger.error("Categories endpoint returned invalid JSON: %s", resp.text)
        raise RuntimeError("Categories endpoint returned invalid JSON")


def main():
    client_id = CLIENT_ID
    client_secret = CLIENT_SECRET

    if not client_id or not client_secret:
        logger.info("ALLEGRO_CLIENT_ID or ALLEGRO_CLIENT_SECRET not set in environment.")
        client_id = input("Enter Client ID: ").strip()
        client_secret = input("Enter Client Secret: ").strip()

    # NOTE: Prefer verify=True. If using a sandbox with self-signed certs, provide a path to the CA bundle instead.
    ssl_verify = os.getenv("ALLEGRO_SSL_VERIFY", "true").lower() not in ("0", "false", "no")

    try:
        token = get_access_token(client_id, client_secret, verify=ssl_verify)
        logger.info("Access token retrieved (truncated): %s", (token[:20] + "...") if token else "<empty>")
    except RuntimeError as e:
        logger.error("Auth failed: %s", e)
        sys.exit(1)

    try:
        categories = get_main_categories(token, verify=ssl_verify)
    except RuntimeError as e:
        logger.error("Failed to fetch categories: %s", e)
        sys.exit(1)

    items = categories.get("categories") or categories.get("items") or categories
    logger.info("Top-level categories count: %s", len(items) if hasattr(items, "__len__") else "unknown")

    # Print the JSON response to stdout for convenience (caller can pipe or inspect as needed)
    print(categories)


if __name__ == "__main__":
    main()
