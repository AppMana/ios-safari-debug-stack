# Third-party components

The repository vendors source snapshots so Debian package builds do not fetch
or execute code from the network.

| Component | Pin | License | Purpose |
| --- | --- | --- | --- |
| google/ios-webkit-debug-proxy | v1.9.2 / `278bf48` | BSD-3-Clause | Raw WebKit Inspector proxy |
| EvanBacon/inspect-webkit | v0.0.5 / `fdad65f` | MIT | WIP-to-CDP translation |
| HimbeersaftLP/ios-safari-remote-debug-kit | `568a77b` | GPL-3.0 | Chromium-compatible Web Inspector patches |
| WebKit WebInspectorUI | `37082295192386f21f8e17f4e8295e18f61c1da3` | BSD family and embedded licenses | Human inspector frontend |
| commander | 14.0.3 | MIT | CDP bridge CLI parsing |
| ws | 8.18.0 | MIT | CDP WebSocket server |

Downstream patches are intentionally small and are documented in the README.
When updating a snapshot, preserve its license files, update this table and
`VERSION.json`, rebuild both Ubuntu targets, and repeat the hardware smoke test.
