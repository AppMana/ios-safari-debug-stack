#!/usr/bin/python3
"""Generate a minimal SPDX 2.3 package SBOM for a Debian binary package."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


def field(package: Path, name: str) -> str:
    return subprocess.check_output(
        ["dpkg-deb", "--field", str(package), name], text=True
    ).strip()


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} PACKAGE.deb OUTPUT.spdx.json", file=sys.stderr)
        return 64
    package = Path(sys.argv[1])
    output = Path(sys.argv[2])
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    name = field(package, "Package")
    version = field(package, "Version")
    architecture = field(package, "Architecture")
    document = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"{name}-{version}-{architecture}",
        "documentNamespace": f"https://github.com/AppMana/ios-safari-debug-stack/sbom/{uuid.uuid4()}",
        "creationInfo": {
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "creators": ["Organization: AppMana", "Tool: generate_sbom.py-1"],
        },
        "packages": [
            {
                "name": name,
                "SPDXID": "SPDXRef-Package",
                "versionInfo": version,
                "supplier": "Organization: AppMana",
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "licenseConcluded": "NOASSERTION",
                "licenseDeclared": "GPL-3.0-or-later",
                "copyrightText": "NOASSERTION",
                "checksums": [{"algorithm": "SHA256", "checksumValue": digest}],
                "externalRefs": [
                    {
                        "referenceCategory": "PACKAGE-MANAGER",
                        "referenceType": "purl",
                        "referenceLocator": f"pkg:deb/ubuntu/{name}@{version}?arch={architecture}",
                    }
                ],
            }
        ],
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": "SPDXRef-Package",
            }
        ],
    }
    output.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
