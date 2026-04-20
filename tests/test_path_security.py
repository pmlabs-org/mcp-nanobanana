"""Path-security regression tests (Pathfinder fork, 2026-04-20).

Added to close the deploy-time security review's file-system-overreach
findings. When IMAGE_OUTPUT_DIR is set, every caller-supplied path must
resolve inside that directory — absolute paths outside the root, `..`
escapes, and silently-following symlinks to outside the root must all
be rejected.
"""

from pathlib import Path

import os
import pytest

from nanobanana_mcp_server.core.exceptions import ValidationError
from nanobanana_mcp_server.utils.validation_utils import (
    ensure_inside_image_root,
    validate_output_path,
)


@pytest.fixture
def image_root(tmp_path, monkeypatch):
    root = tmp_path / "images"
    root.mkdir()
    monkeypatch.setenv("IMAGE_OUTPUT_DIR", str(root))
    return root


class TestEnsureInsideImageRoot:
    def test_accepts_path_inside_root(self, image_root):
        inside = image_root / "ok.png"
        inside.touch()
        result = ensure_inside_image_root(str(inside))
        assert Path(result) == inside.resolve()

    def test_accepts_nested_path_inside_root(self, image_root):
        nested = image_root / "client-a" / "logo.png"
        nested.parent.mkdir()
        nested.touch()
        result = ensure_inside_image_root(str(nested))
        assert Path(result) == nested.resolve()

    def test_rejects_absolute_path_outside_root(self, image_root, tmp_path):
        outside = tmp_path / "outside.png"
        outside.touch()
        with pytest.raises(ValidationError, match="must be inside IMAGE_OUTPUT_DIR"):
            ensure_inside_image_root(str(outside))

    def test_rejects_dotdot_escape(self, image_root):
        escape = f"{image_root}/../escape.png"
        with pytest.raises(ValidationError, match="must be inside IMAGE_OUTPUT_DIR"):
            ensure_inside_image_root(escape)

    def test_rejects_system_paths(self, image_root):
        with pytest.raises(ValidationError, match="must be inside IMAGE_OUTPUT_DIR"):
            ensure_inside_image_root("/etc/passwd")

    def test_rejects_empty(self, image_root):
        with pytest.raises(ValidationError):
            ensure_inside_image_root("")

    def test_rejects_whitespace_only(self, image_root):
        with pytest.raises(ValidationError):
            ensure_inside_image_root("   ")

    def test_legacy_mode_when_env_unset(self, monkeypatch, tmp_path):
        monkeypatch.delenv("IMAGE_OUTPUT_DIR", raising=False)
        inside = tmp_path / "anywhere.png"
        inside.touch()
        assert ensure_inside_image_root(str(inside)) == str(inside.resolve())

    @pytest.mark.skipif(
        os.name == "nt",
        reason="legacy Linux system-dir blocklist doesn't resolve on Windows",
    )
    def test_legacy_mode_still_blocks_system_paths(self, monkeypatch):
        monkeypatch.delenv("IMAGE_OUTPUT_DIR", raising=False)
        with pytest.raises(ValidationError, match="system directory"):
            ensure_inside_image_root("/etc/passwd")


class TestValidateOutputPath:
    def test_none_is_allowed(self, image_root):
        validate_output_path(None)

    def test_empty_string_rejected(self, image_root):
        with pytest.raises(ValidationError, match="empty"):
            validate_output_path("")

    def test_inside_root_accepted(self, image_root):
        target = image_root / "new.png"
        validate_output_path(str(target))

    def test_outside_root_rejected(self, image_root, tmp_path):
        outside = tmp_path / "writeanywhere.png"
        with pytest.raises(ValidationError, match="must be inside IMAGE_OUTPUT_DIR"):
            validate_output_path(str(outside))

    def test_dotdot_escape_rejected(self, image_root):
        with pytest.raises(ValidationError, match="must be inside IMAGE_OUTPUT_DIR"):
            validate_output_path(f"{image_root}/../bad.png")
