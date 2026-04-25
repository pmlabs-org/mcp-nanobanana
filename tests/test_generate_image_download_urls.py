"""Pathfinder fork — generate_image emits download_urls[] for local-download."""

import os
import pytest
from unittest.mock import patch


class TestDownloadUrlsEmission:
    """download_urls[] lets Claude curl the image to the local disk after
    generation (see spec 2026-04-24-nanobanana-local-download-design.md)."""

    def _structured(self, metadata, env):
        """Helper: call the URL builder logic in isolation (via import)."""
        from nanobanana_mcp_server.tools.generate_image import (
            _build_download_urls,
        )
        with patch.dict(os.environ, env, clear=False):
            return _build_download_urls(metadata)

    def test_one_image_one_url(self):
        metadata = [{"storage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]
        urls = self._structured(
            metadata,
            {"NANOBANANA_PUBLIC_URL": "https://nano.example.com"},
        )
        assert urls == [
            "https://nano.example.com/images/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png"
        ]

    def test_multiple_images_multiple_urls(self):
        metadata = [
            {"storage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
            {"storage_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"},
        ]
        urls = self._structured(
            metadata,
            {"NANOBANANA_PUBLIC_URL": "https://nano.example.com"},
        )
        assert len(urls) == 2
        assert urls[0].endswith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png")
        assert urls[1].endswith("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png")

    def test_trailing_slash_is_stripped(self):
        metadata = [{"storage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]
        urls = self._structured(
            metadata,
            {"NANOBANANA_PUBLIC_URL": "https://nano.example.com/"},
        )
        assert urls[0] == "https://nano.example.com/images/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png"

    def test_empty_list_when_env_unset(self, monkeypatch):
        """When NANOBANANA_PUBLIC_URL is unset, download_urls must be []."""
        monkeypatch.delenv("NANOBANANA_PUBLIC_URL", raising=False)
        from nanobanana_mcp_server.tools.generate_image import _build_download_urls
        metadata = [{"storage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]
        assert _build_download_urls(metadata) == []

    def test_empty_list_when_env_whitespace(self, monkeypatch):
        """Whitespace-only NANOBANANA_PUBLIC_URL is treated as unset."""
        monkeypatch.setenv("NANOBANANA_PUBLIC_URL", "   ")
        from nanobanana_mcp_server.tools.generate_image import _build_download_urls
        metadata = [{"storage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]
        assert _build_download_urls(metadata) == []

    def test_skips_metadata_without_storage_id(self):
        metadata = [
            {"storage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},
            {"full_path": "/data/foo.png"},  # no storage_id
            None,
            {"storage_id": "cccccccc-cccc-cccc-cccc-cccccccccccc"},
        ]
        urls = self._structured(
            metadata,
            {"NANOBANANA_PUBLIC_URL": "https://nano.example.com"},
        )
        assert len(urls) == 2
