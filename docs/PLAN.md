# Digby — product and technical plan

Digby is a DNS server built on rummage. It replaces Technitium on the homelab, it is designed security-first rather than feature-first, and everything in it that is not DNS belongs to rummage. This document is the plan: what runs today, the two operating modes and the topology each produces, the extension split, the rummage gaps it depends on, the standalone integration libraries, the build order, the cutover from Technitium, certificates, testing, and the questions still open.

Status: revision 2 of the draft, with the decisions taken on the first revision folded in (marked **decided** in §13; everything else carries a recommendation marked *default — not yet confirmed*). Only the wire codec is implemented (§6.19); the other `digby-ext-*` repositories and the `digby` app are scaffolds. Probing of the live homelab on 2026-11-12 was read-only.

## Contents

1. [What runs today](#1-what-runs-today)
2. [Design principles, and where Digby deliberately differs from Technitium](#2-design-principles-and-where-digby-deliberately-differs-from-technitium)
3. [Architecture: control plane on rummage, data plane in server and wire](#3-architecture-control-plane-on-rummage-data-plane-in-server-and-wire)
4. [Two modes and the target topology](#4-two-modes-and-the-target-topology)
5. [Security](#5-security)
6. [Extensions and libraries](#6-extensions-and-libraries)
7. [Rummage gaps](#7-rummage-gaps)
8. [Install, deploy and update](#8-install-deploy-and-update)
9. [Build order](#9-build-order)
10. [Cutover from Technitium (mode 1)](#10-cutover-from-technitium-mode-1)
11. [Certificates: taking over from acme.sh](#11-certificates-taking-over-from-acmesh)
12. [Testing](#12-testing)
13. [Open questions and decisions](#13-open-questions-and-decisions)
14. [Appendix: probe results](#14-appendix-probe-results)

## 1. What runs today

Everything below was read from host 01 on 2026-11-12 with `dig`, `resolvectl`, `tailscale status`, `tailscale dns status`, `ss`, `ps`, `ip`, `docker ps`, `openssl s_client` and unauthenticated `curl` to the gateway. Nothing was changed.

### Host 01

- Hostname `01.homelab.cldmv.net`. LAN address `10.0.1.165/23` on `eno1`; the LAN is `10.0.0.0/23` (10.0.0.0–10.0.1.255), default gateway `10.0.0.1` (the UniFi gateway, a **UDM Pro SE**), address obtained by DHCP on the NetworkManager connection "Wired connection 1". Tailnet address `100.64.178.0`, MagicDNS name `01-homelab-cldmv.tail935f4f.ts.net`.
- `systemd-resolved` in uplink mode. `/etc/resolv.conf` carries exactly `nameserver 10.0.1.165` with `search localdomain tail935f4f.ts.net`. Link `eno1`: DNS `10.0.1.165`, domain `localdomain` (from UniFi's DHCP). Link `tailscale0`: `100.100.100.100` and `fd7a:115c:a1e0::53` for `tail935f4f.ts.net` and the tailnet reverse zones. Global DNSSEC `no/unsupported`.
- k3s pins `resolv-conf: /etc/rancher/k3s/resolv.conf` → `nameserver 10.0.1.165`.
- **Every public listener on 01 binds every address.** Technitium binds `0.0.0.0:53` and `[::]:53`. Ports 80 and 443 are held by **traefik** (`traefik:latest`, a Docker container in the Portainer stack `traefik-proxy`, not k3s, publishing `0.0.0.0` and `[::]` on 80 and 443 and mounting `/srv/certs` and `/srv/traefik/dynamic`; `tailscale serve` is not in use), which presents the Let's Encrypt certificate `CN=homelab.cldmv.net` with SANs `*.homelab.cldmv.net`, `*.01.homelab.cldmv.net`, `*.scopra.homelab.cldmv.net` and `homelab.cldmv.net`, answers HTTP/2 and returns Go's plain-text 404 for unknown hosts. Its dynamic configuration lives in `/srv/traefik/dynamic`. An nginx also runs (root master, workers) but holds neither 80 nor 443. Nothing listens on 853. Port 5380 is Technitium's HTTP UI. Consequence: Digby cannot bind `.166:53` while Technitium runs, nor `.166:443` until the traefik container's port bindings are narrowed to `10.0.1.165`, `100.64.178.0` and `::1` in Portainer (a step for the operator; §10).
- `avahi-daemon` (mDNS) is active. The Docker daemon behind `/var/run/docker.sock` runs the scopra test stack only.

### Technitium

- Runs as `/usr/bin/dotnet /opt/technitium/dns/DnsServerApp.dll /etc/dns` inside a Docker container (`/system.slice/docker-90168b08….scope`) that the Docker daemon behind `/var/run/docker.sock` does not know, so it runs under another daemon or data root. Its configuration, zone files and query logs were not readable (Q9).
- Recursive resolver with DNSSEC validation on (`ad` for `cloudflare.com`; `SERVFAIL` for `dnssec-failed.org`), EDNS buffer 1232, refuses non-recursive queries outside its zones.
- **Zones** (**decided**, Q9, confirmed: Technitium holds only `homelab.cldmv.net` plus the empty `quack.shellback.net`; no query history or settings are wanted, so there is no data migration, only zone content). What read-only probing showed agrees: AXFR from 01 is refused. Non-recursive SOA probes with the `aa` flag show exactly two zones. `homelab.cldmv.net` (SOA `homelab.cldmv.net. hostadmin.homelab.cldmv.net. 5 900 300 604800 900`, NS `homelab.cldmv.net.`, apex A `10.0.1.165`) carries a **wildcard**: a random name under it answers `10.0.1.165` with `aa`; `01` and `scopra` are names inside it or sub-zones, which the SOA probe cannot tell apart. And `quack.shellback.net` is a zone of its own that is **empty** (SOA with `aa`, no A record: `NODATA`), which is why the Tailscale split route to it answers nothing. Technitium is **not** authoritative for `cldmv.net`, `shellback.net`, `localdomain`, `0.0.10.in-addr.arpa`, `1.0.10.in-addr.arpa`, `10.in-addr.arpa`, `100.in-addr.arpa`, `tail935f4f.ts.net`, `lan`, `home.arpa`, `internal` or `local` (all `REFUSED`). Only those two zones are imported (§10).
- `quack.shellback.net` is the intended name of a future Quack instance on `llm-server`, the node shared in from another tailnet; §4.15 plans it as the worked example of naming a shared-in device, and the health check in §4.9 flags a split route whose target cannot answer its names.

### The UniFi gateway

- UDM Pro SE (UniFi OS reports `hardware.shortname: UDMPROSE`, `deviceState: updateAvailable`); the Network application's version is not readable without credentials (`/proxy/network/status` → 401). Its own certificate is the self-signed `unifi.local`.
- It hands out `10.0.1.165` as the one DNS server and `localdomain` as the search domain. That single address is the real problem: when host 01 is down, every client loses all DNS, internet names included.
- **Native per-domain forwarding exists.** The UniFi Network application has local DNS records since 8.2 (Host A/AAAA, MX, TXT, SRV) and a **Forward Domain** record type that forwards a domain and its subdomains to another DNS server, which the gateway must be able to reach; Ubiquiti's guidance is to enter the base domain only. Where it lives depends on the version: Settings › Routing › DNS on 8.x, Settings › Policy Engine › DNS on 9.3, Settings › Policy Table on 9.4. The official help pages refuse automated fetches (HTTP 403), so this comes from Ubiquiti's own text as quoted by search results and from third-party write-ups; §4.2 says what still has to be verified on the console and how `lib-unifi` detects it. Local records and forward rules only apply to clients whose DNS server is the gateway. Hand-edited dnsmasq configuration is not an option: UniFi OS rewrites it on update.
- The legacy controller API that `CLDMV/unifi-cli` uses (`/srv/repos/automation/unifi-cli/lib/api/`) covers what the official API may not: `api/s/{site}/rest/networkconf` (networks, with their DHCP DNS and domain settings), `api/s/{site}/rest/user/{id}` and `v2/api/site/{site}/client/{id}` (fixed IPs), device detection and an `auto-ip` task.

### Public DNS

- `cldmv.net` and `shellback.net` are on Route 53. `cldmv.net` is not DNSSEC-signed. CAA allows `awstrust.com` and `letsencrypt.org`.
- `*.homelab.cldmv.net` is a wildcard A → `100.64.178.0` inside `cldmv.net`; no delegation of `homelab.cldmv.net`; apex → `52.36.212.193`; `ics.cldmv.net` → `15.204.120.140` (the VPS relay) everywhere. The wildcard stays as it is, maintained by hand, through the first release (**decided**, Q3).
- acme.sh at `/srv/acme/acme.sh` renews the wildcard into `/srv/certs/homelab.key` and `/srv/certs/homelab.fullchain.pem` (last renewed 2026-09-26). Both are `root:repo` mode 0640 with an ACL `user:glmtest:r--`, mask `r--`, nothing for others. Readers: the traefik container (bind-mounts `/srv/certs` → `/certs`), Quack on `:18543` (reads the pair through its rummage config), and glmtest's Quack instances (through the ACL) (**decided**, Q20). The DNS-01 provider is almost certainly Route 53; its account configuration was not read.

### The split-horizon gap

Two independent authorities answer the same names: Route 53 says `100.64.178.0`, Technitium says `10.0.1.165`. The Oct 4 "Override DNS servers" change sent every tailnet client to Technitium and so to the LAN address that is unreachable away from home; turning it off fixed that and broke k3s CoreDNS, whose pods held a stale `resolv.conf`. Digby's answer: one authority, per-client views, and never a tailnet-wide override.

### Tailnet

MagicDNS on (suffix `tail935f4f.ts.net`). No tailnet-wide resolvers (Override off). Split routes: `quack.shellback.net → 100.64.178.0`, `ts.net → 199.247.155.53` / `2620:111:8007::53`. Peers: `ics-laptop`, `ipad172`, `iphone-15-pro`, `stratax-proxy` (`cldmv.net@`) and `llm-server.tail540c89.ts.net`, shared in from another tailnet (`timeless.wines@`). Whether 01 advertises any subnet route could not be read without `--json`.

### Dependents

Stratax (`ics.cldmv.net`, through the relay), Quack, Hoot and Jellytagger (`*.homelab.cldmv.net` on 01, behind traefik), k3s and the Actions runners (CoreDNS → 10.0.1.165), the acme.sh renewal (Route 53 API), and every DHCP client UniFi hands `10.0.1.165` to.

## 2. Design principles, and where Digby deliberately differs from Technitium

| Area | Technitium | Digby |
|---|---|---|
| Configuration | Files written by the UI; no history | rummage records with full history and tombstones; every change an atomic action in the journal; irreversible changes can require a second decision (rummage requests) |
| Identity | Its own users; an API token in the query string | rummage auth (password fill, claim on first visit), rummage person permissions and roles, per-person API keys, the read-only test key for same-machine automation; the admin UI's reach is the operator's setting (Q13) |
| Automation and integration | One web API, token in the query string | A declarative REST API (`/api/v1/<ext>/…`, OpenAPI generated) and an MCP server, every operation contributed by the extension or driver that owns it, nothing hard-coded, under rummage's auth, rate limits and audit (G13) |
| Resilience | One server, one address, everything or nothing | Two modes (§4): the gateway forwards only Digby's domains while there is one machine, so an outage of 01 costs homelab names and nothing else; several linked Digby nodes handed out directly once more servers exist |
| Split horizon | An optional app with address-based answers | Views are core: one zone, per-view variants, classified by client address and ingress listener |
| Public DNS | You host it yourself, on :53 | Digby is never the public authority. Route 53 stays; in the first release Digby does not touch it; later it writes `_acme-challenge` TXT records for certificates and, later still, syncs the `homelab` subtree it owns |
| Machine and address data | Typed by hand or from its DHCP | Sourced: UniFi (networks, clients, fixed IPs) and Tailscale (devices) through standalone libraries, with an IP-address-management view linking addresses, machines and records |
| The network itself | Out of scope | Digby manages UniFi's DNS settings for every network (the DNS servers handed out, the search domain, forward rules, fixed IPs), checks the tailnet's DNS health, and can share chosen LAN networks with the tailnet; every write opt-in, admin-only and audited |
| Privilege | Root (bare metal) or a root container | A service user with `CAP_NET_BIND_SERVICE` only, a hardened unit, secrets in rummage secrets or systemd credentials |
| Recursion | Forwarders by default | Full recursion from the root servers with DNSSEC validation, in every mode, from the first release (**decided**, Q4); forwarders are an option per zone or globally |
| Amplification | Whatever its ACL says | Recursion only for admitted views; RRL on authoritative answers; minimal `ANY` (RFC 8482); `TC` under pressure; cookies |
| Transports | UDP, TCP, DoT, DoH, DoQ with its own certificates | UDP, TCP from the first release; DoT and DoH with certificates Digby itself obtains and renews (§11); DoQ when Node's QUIC is stable |
| Certificates | Self-signed or imported | ACME through a rummage TLS extension (G8), wildcard via DNS-01 answered through Route 53 with a scoped IAM policy, renewed into the same files services read today |
| Updates | In-app download as root, or an image pull | `rummage deploy`: signed releases, A/B slots, health gate including a real DNS probe, automatic rollback, a verified backup before every deploy |
| Logs | Query logs on disk | Telemetry in a bounded series store, never records; aggregated statistics by default |
| Blocking, DHCP | Built in | Blocking is a future feature (not used today, **decided**, Q5); DHCP stays on UniFi (**decided**, Q2) |

Principles:

1. **Anything not DNS-specific is rummage's**, and anything that is a third-party API is a standalone library. Listeners, outbound sockets, telemetry stores, roles, replication, TLS renewal, an operational to-do and the deploy's capability grants are framework capabilities (§7); UniFi, Tailscale and Route 53 clients are `lib-*` packages Digby's extensions wrap (§6.1).
2. **Control plane and data plane are separate.** Configuration is records; the query path is one extension's engine on immutable compiled snapshots.
3. **One authority, many views, two modes.** The LAN, the tailnet and the public internet see one zone through views; the mode decides who hands Digby to the clients.
4. **Fail closed, answer honestly, degrade visibly.** A gate refuses a null caller; a query a view does not admit gets `REFUSED`; the active mode and what it costs are always on the health page.
5. **No outage on cutover.** Digby gets its own address, runs beside Technitium, is compared against it, and clients move by gateway changes that are each reversible in one step.

## 3. Architecture: control plane on rummage, data plane in server and wire

```text
            ┌──────────────────────────────── control plane (rummage) ────────────────────────────────┐
            │ shell views · settings · records with history · journal · requests · MCP · to-do        │
            │ zones ─┐ views ─┐ dnssec ─┐    networks (orchestrator) ← drivers: unifi · tailscale → machines │
            │        │        │         │    public (acme dns-01 → route53)   health → admin to-do     │
            └────────┼────────┼─────────┼──────────────────────────────────────────────────────────────┘
                     ▼        ▼         ▼
          compiled snapshots: zone tables (per view) · view classifier · signed RRsets
                     │
   ┌─────────────────▼──────────────────── data plane (digby-ext-server) ────────────────────────────────────────┐
   │ listeners (udp/tcp/tls/https) ← self.host.net.listen   codec ← self.wire.*   view classify   RRL · cookies  │
   │ authoritative lookup over snapshots → cache → on miss: resolver (iterative, validating)                     │
   │ counters → logs (series store)                                                                              │
   └─────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Records are the source of truth.** `zone`, `rrset`, `view`, `listener`, `network`, `address`, `machine`, `health-finding`, `tsig-key`, `dnssec-key`, `public-zone`, `cluster-node` are declared record types, each with a `validate` leaf, history and tombstones, scope `org`. Writes go through `self.host.records.apply` inside actions; the shell writes through `ctx.data.records(type)`.
- **Compiled snapshots.** A control-plane extension recompiles an immutable snapshot on its own `data:changed` and hands it to the server through one scoped leaf, `self.server.snapshot.set(kind, snapshot)`. The server swaps the pointer atomically; a query never calls another extension.
- **The resolver** is the one cross-extension call on the query path, on a cache miss only, captured at activate. It recurses from the root servers with DNSSEC validation in every mode; forwarders are configuration, not the default.
- **No I/O outside the framework.** Sockets from `self.host.net.listen` (G1); upstream exchanges from `self.host.net.udp.exchange` / `tcp.connect` (G2); HTTP to UniFi, Tailscale and Route 53 through the guarded fetch injected into the libraries (G6). `rummage audit network` keeps it that way.
- **Integration libraries are plain ESM** with injected credentials and fetch, no rummage, no Digby: `@cldmv/lib-unifi`, `@cldmv/lib-tailscale` and `@cldmv/lib-route53` (**decided**, Q18). Driver extensions wrap them (`networks-driver-unifi`, `networks-driver-tailscale`, `public-driver-route53`); the orchestrators they plug into add records, permissions, audit and UI.
- **Performance.** A homelab's load is tens of queries per second with bursts into the thousands; a single Node process with the hot path inside one extension handles it with room; the budget is under 1 ms for an authoritative or cached answer (§12).
- **Platform.** A served rummage app (`rummage build --target web`); `self.host.role()` is `"server"`; every extension declares `platforms: ["web"]`.

## 4. Two modes and the target topology

Digby supports two modes. The `networks` orchestrator switches between them through its UniFi driver (opt-in writes), and the health page always shows which is active and what it costs.

### 4.1 Mode 1 — one machine (the first release)

The gateway stays the clients' DNS server and forwards internet names to public resolvers. It forwards **only Digby's domains** to Digby: `homelab.cldmv.net`, the reverse zones `0.0.10.in-addr.arpa` and `1.0.10.in-addr.arpa`, `tail935f4f.ts.net` (so LAN devices without Tailscale resolve MagicDNS names through Digby's forward zone), and any other domain the administrator names. If host 01 is down, only those names fail; the internet keeps working.

| Role | Where | Answers |
|---|---|---|
| Clients' resolver | The UDM Pro SE (`10.0.0.1` and each network's gateway address) | Internet names via its upstreams; Digby's domains forwarded to `10.0.1.166` |
| Authoritative, private | Digby on 01, LAN address `10.0.1.166`, tailnet address `100.64.178.0` | `homelab.cldmv.net` per view, the reverse zones, forward zones |
| Recursive, validating | The same Digby | Full resolution for any client that points at Digby directly: host 01 itself, k3s CoreDNS, a tailnet client whose DNS is set to Digby, a device set by hand |
| Public | Route 53, untouched | The hand-maintained wildcard `*.homelab.cldmv.net → 100.64.178.0` |

**What mode 1 costs**, spelled out on the health page:

- Digby sees the gateway as the client for LAN traffic, so there are no per-network views and no per-device query logs for LAN clients; the `lan` view is "whatever arrives from the gateway's addresses".
- Blocking (a future feature) would cover only Digby's own domains for LAN clients.
- Internet DNSSEC validation for LAN clients is whatever the gateway's upstream does, not Digby's. Clients pointed straight at Digby get Digby's validation.
- One machine is still one machine: homelab names and the admin UI are down when 01 is down.

**The UniFi side of mode 1.** DHCP hands out the gateway as the DNS server (UniFi's default), the search domain `homelab.cldmv.net`, and Forward Domain rules for Digby's domains. The gateway's own upstream stays a public resolver. UniFi's DNS filtering features stay off. Whether every piece is available natively on this console is the first thing `lib-unifi` establishes (§4.2).

### 4.2 UniFi: native per-domain forwarding, verification and alternatives

**Finding.** UniFi has the needed feature natively: the Forward Domain record type (§1). It forwards a domain and its subdomains to one target server the gateway can reach. What is not yet confirmed and has to be checked on the console, read-only, with the API key the integration will use:

1. The Network application's version (not readable unauthenticated; UniFi OS reports an update available). Forward Domain needs a 9.x Network application; the console update is a step for the operator if the version predates it.
2. That a reverse zone (`1.0.10.in-addr.arpa`) is accepted as a Forward Domain. It is a domain like any other, so it should be; if the UI rejects it, mode 1 forwards only forward names and reverse lookups fall to Digby's straggler listener on `.165` (§10) until mode 2.
3. Which API exposes the rules: the official Integration API (API key) or the legacy `v2/api/site/{site}/static-dns` records. `lib-unifi` probes both and reports the capability as `dns.forward: official | legacy | none`.

**Alternatives if the console cannot do it natively**, in order of preference:

- (A) Apply the pending console update and re-check. Recommended first.
- (B) DHCP hands out Digby first and the gateway second. Most stub resolvers use the first server until it fails, then fall back, so an outage of 01 costs a timeout per lookup and then works; views, logs and recursion are Digby's while it is up. Semantics vary by client (Android spreads queries; Windows sticks to the fallback for minutes), so it is a degraded mode 1, honest on the health page.
- (C) Digby as the gateway's upstream resolver. Rejected: dnsmasq spreads queries across upstreams, so a public resolver would answer `homelab` names with the public wildcard for LAN clients, and an outage of 01 still takes everything down unless a second upstream exists, which brings the inconsistency back.

`lib-unifi` detects the capability and the UniFi driver reports it; the `networks` orchestrator refuses to apply mode 1 when it is `none`, offers (B) instead, and says so on the health page.

### 4.3 Mode 2 — several linked Digby nodes (a later slice)

Multi-server is one generic feature (**decided**, Q6): install Digby on several servers and link them. A node is any server Digby runs on; whether it is a small board, a VPS or anything else makes no difference to the design, and what a node can usefully serve depends only on what can reach it: a node on the LAN is handed out by UniFi for the `lan` view, a node reachable over the tailnet is a split-route target for the `tailnet` view, a node on both serves both.

In mode 2 UniFi hands out the LAN-reachable nodes directly on every network and the Forward Domain rules are removed. Every client reaches Digby itself: full per-network views, per-device logs, recursion with Digby's DNSSEC validation, blocking when it exists. The cluster extension replicates records from the primary to the other nodes (G7); each node compiles its own snapshots and recurses on its own.

The switch is one action in the `networks` orchestrator (plan, approve, apply, written through the UniFi driver): DHCP DNS servers → the LAN nodes' addresses; search domain unchanged; forward rules removed; the health page shows mode 2 and its remaining costs (no floating address; a node that is down is skipped by clients after their own timeout).

### 4.4 Addresses

Digby gets its **own LAN address `10.0.1.166`** (**decided**, Q1): a second address on `eno1`, added to the NetworkManager connection (`nmcli con mod "Wired connection 1" +ipv4.addresses 10.0.1.166/23`, then `nmcli con up`, a brief blip), and reserved in UniFi (a fixed IP or reservation) so DHCP never hands it out; `.166` answers no ARP or ping today. Host 01 keeps `10.0.1.165` for traefik, Quack, Hoot and Jellytagger; their records keep pointing at `.165`. In the long run, adding an address to the box belongs to Digby's `networks` orchestrator and its UniFi driver (§4.10), not to a hand-typed command.

Because Technitium and traefik both bind every address today, Digby cannot bind `.166:53` until Technitium stops (it goes away at cutover, §10) and cannot bind `.166:443` until the traefik container's port bindings are narrowed to `10.0.1.165`, `100.64.178.0` and `::1` (Q27) in Portainer (a step for the operator; §10 Phase 0). The narrowing is interim: Digby replaces traefik with its own proxy (§6.18, slice 3b), and traefik is removed once the proxy reaches parity (§10 Phase 6). Digby's listeners are configured for their addresses ahead of time and bind when the port frees (`retryBind`, G1), so the gap between Technitium stopping and Digby answering is under a second.

After cutover Digby also listens on `10.0.1.165:53` as a straggler listener, so anything still pointing there keeps working and shows in the logs with its source address.

### 4.5 Views

| View | Clients | `*.homelab.cldmv.net` | Recursion |
|---|---|---|---|
| `lan` | `10.0.0.0/23`, `127.0.0.0/8`; in mode 1 effectively the gateway's addresses | per-host A → `10.0.1.x`, wildcard → `10.0.1.165`; reverse zones | yes, validating |
| `tailnet` | `100.64.0.0/10`, `fd7a:115c:a1e0::/48` | per-host → the host's tailnet addresses, wildcard → `100.64.178.0` | yes, validating |
| `public` | everything else | not served; the projection target for a later Route 53 sync | **refused** |

One zone, per-view variants; the compiler resolves the tables. In mode 2 the `lan` view can be split per UniFi network (one view per VLAN) because Digby sees real client addresses; the `networks` extension supplies the CIDRs.

### 4.6 Tailnet clients and shared-node users

- A **Tailscale split DNS route** `homelab.cldmv.net → 100.64.178.0` (the Tailscale admin console, or Digby's Tailscale driver once its write scope is on). Tailnet clients ask Digby for that domain only and hear the `tailnet` view; every other name goes to the client's own resolver. Nothing tailnet-wide changes; "Override DNS servers" stays **off**.
- Public DNS keeps the wildcard → `100.64.178.0` for tailnet devices with MagicDNS off and for **shared-node users**, who sit on another tailnet and receive that tailnet's DNS configuration, never ours. They reach 01 by its tailnet address over the share. Shared-node users never receive subnet routes either; that is Tailscale's behaviour, and §4.9 states it where it matters.
- **Shared-in devices get names too** (**decided**, Q15): a node shared from another tailnet (`llm-server`) is a `machine` like an owned device, named under the `tailnet` view by the same rules (`<hostname>.homelab.cldmv.net` → its tailnet addresses); an administrator can rename or hide any machine, owned or shared.
- The Tailscale driver's checks watch this configuration (§4.9).

### 4.7 MagicDNS coexistence

Digby never serves `tail935f4f.ts.net`; it forwards it (and the tailnet reverse zones) to `100.100.100.100` on 01, admitted for the `lan` and `tailnet` views. In mode 1 the gateway forwards `tail935f4f.ts.net` to Digby too, so LAN devices without Tailscale resolve MagicDNS names. `tailscale set --accept-dns=true` stays on 01.

### 4.8 k3s CoreDNS and host 01

- `/etc/rancher/k3s/resolv.conf` becomes `nameserver 10.0.1.166` then `nameserver 10.0.0.1`; CoreDNS's forward plugin health-checks its upstreams, so pods get Digby's full validated resolution and fall back to the gateway when Digby alone is down. A `rollout restart` of CoreDNS after the change clears any stale copy (the Oct 25 incident).
- Host 01's resolver follows DHCP (the gateway in mode 1). Pointing it at Digby first, gateway second, is an optional resolved drop-in (`DNS=10.0.1.166 10.0.0.1`), under the standing rule: after any resolved restart, `resolvectl status` must show an empty Global and `100.100.100.100` only on `tailscale0`.

### 4.9 Tailnet health and sharing LAN networks

The Tailscale driver of the `networks` orchestrator (wrapping `lib-tailscale`) runs these checks, and the orchestrator turns each failure into an **admin to-do item with exact fix steps** (through `health`) that stays until the check passes:

| Check | Pass condition | Fix steps offered |
|---|---|---|
| Split route | `homelab.cldmv.net → <Digby tailnet address(es)>` present | Add it in the admin console (exact path), or let Digby add it (needs the `dns` write scope) |
| Override DNS | off | Turn it off; why (the October incident) |
| MagicDNS | on | Turn it on |
| Subnet routes | routes advertised by 01 are approved, and approved routes are advertised | Approve in the console, or re-advertise on 01 |
| ACLs | the policy admits the shared subnets only to the chosen people and devices; no rule exposes Digby's admin port tailnet-wide | The marked block Digby maintains, or the manual edit |
| Shared-in nodes | each shared-in node has a `machine` record and a name, or was hidden by an administrator | Name it (the default naming applies), rename it, or hide it |
| Nameserver reachability | Digby's tailnet listener answers from a tailnet peer | Listener status, firewall |
| Split routes answered | every split route's target answers the names it is routed (a query for the domain's apex and a sampled name gets an answer, not a refusal or a timeout) | Point the route at a server that serves the domain (Digby, with the zone or a machine name), or remove the route; the finding is raised, never acted on by itself |

**The Tailscale credential starts read-only** (**decided**, Q15): the OAuth client used for health and for the device inventory carries read scopes only. Writes (the split route, routes, the policy file) are enabled separately, as an opt-in that names the write scopes it needs and asks for a second OAuth client or a widened one.

**Sharing chosen LAN networks with the tailnet** (**decided**, Q8b) is an option of the `networks` orchestrator, off by default, network by network: the administrator picks a network from its list and the people or devices allowed; Digby then, through the Tailscale driver, (1) advertises the route on host 01 through tailscaled's LocalAPI (`tailscale set --advertise-routes` semantics, never `tailscale up`), (2) approves it through the Tailscale API, (3) writes an ACL grant limited to the chosen people or devices into a clearly marked block of the policy file (read with its ETag, written with `If-Match`, refused if the file changed meanwhile), and (4) verifies forwarding by resolving and probing a LAN address from a tailnet peer, recording the result. It needs the Tailscale write scopes (the route and policy scopes, as Tailscale currently names them), it needs the service user to be tailscaled's operator on 01 (`tailscale set --operator=digby`, a root step the deploy setup prints, G3), and every step is an audited admin action. Shared-node users never get subnet routes: Tailscale does not share routes across tailnets, so the option page says so.

### 4.10 IP address management and UniFi networks

The `networks` orchestrator is the IPAM: every network its drivers report (every UniFi VLAN and subnet, whatever they are), its CIDR, gateway, DHCP range, the DNS servers and search domain it hands out, and every address: fixed IPs and reservations from UniFi, active leases as UniFi reports them, Digby's own addresses, each linked to its `machine` and to the `rrset`s that name it. Its data comes from UniFi through the UniFi driver; its UI is where fixed IPs are assigned and where a network's DNS settings are edited, each edit a write-through to UniFi that is opt-in, admin-only and audited (§6.8). It is also where mode 1 and mode 2 are applied to every network at once, and, in the long run, where an address is added to a host: the orchestrator plans the address and its reservation, the UniFi driver writes the reservation, and the host-side step (the NetworkManager connection on 01, or the node's own network configuration) is printed as an exact fix step on the admin to-do until G3 can install addresses itself.

### 4.11 Retiring `localdomain`

(**decided**, Q11a.) Digby publishes UniFi's client names under `homelab.cldmv.net` (the `machines` extension, from the devices the UniFi driver reports through `networks`), the DHCP search domain becomes `homelab.cldmv.net`, and `localdomain` is forwarded to the gateway (a forward zone, `localdomain → 10.0.0.1`) for a transition of about a month so anything typed as `<host>.localdomain` keeps resolving; the health page counts queries for it and the forward zone is removed when the count is zero for a week.

### 4.12 Public records

(**decided**, Q3.) Digby does not touch Route 53 in the first release. The wildcard stays hand-maintained. The `public` orchestrator and the Route 53 driver arrive later in two steps: first the single write certificates need (`_acme-challenge` TXT records, §11), then record management starting with the `homelab` subtree (adopt what exists, plan then apply, deletions behind a request), then optionally Route 53's own DNSSEC signing of `cldmv.net`.

### 4.13 Failover and linked servers

Mode 1 fails soft (homelab names only). Mode 2 fails over by listing every LAN-reachable node in DHCP and every tailnet-reachable node in the split route; clients skip a node that is down. Adding a node is generic: install Digby on the server with `rummage deploy`, link it to the primary with a one-time token (§6.14), and the node starts serving whatever views its addresses can reach; the `networks` orchestrator then offers, through its drivers, to add its addresses to DHCP and to the split route. A floating address is a later option nobody needs yet. Until a second node exists, mode 1 is what makes a single DHCP DNS slot acceptable.

### 4.14 DHCP

UniFi keeps DHCP (**decided**, Q2). Name registration comes from reading UniFi's client list, not from serving leases. The `dhcp` extension stays a late optional slice, only with a second node for failover.

### 4.15 Worked example: naming a shared-in device (`quack.shellback.net`)

`llm-server` is shared into this tailnet from another one (`timeless.wines@`); a future Quack instance on it is reachable only through the shared tailnet, never publicly, so there is **no public record** for `quack.shellback.net` (**decided**, Q21). Each side of the share resolves the name inside its own tailnet.

**A shared node does not keep one address.** Tailscale allocates IPv4 addresses per tailnet (it moved from globally unique to locally unique addresses), and a node shared into another tailnet is given a new address there, translated 1:1 by the receiving peers. So `llm-server` is `100.94.135.85` here and something else in its home tailnet, and its own `tailscale ip` shows only the home address. Digby's answer is therefore right for this tailnet only, which is exactly who it serves.

| Side | How `quack.shellback.net` resolves | Who provides it |
|---|---|---|
| This tailnet | The existing split route `quack.shellback.net → 100.64.178.0` sends the name to Digby; Digby answers from the `tailnet` view with the address this tailnet sees for `llm-server` (`100.94.135.85`), kept current by the `machines` orchestrator (Q15: the `machine` record for `llm-server` gets the alias `quack.shellback.net`, which lands in a one-name zone `quack.shellback.net` served in the `tailnet` view only, so the rest of `shellback.net` is never shadowed) | Digby (slice 2; in slice 1 the zone is imported by hand with the address above) |
| The sharer's tailnet | Their own tailnet's DNS: their split route to a resolver of theirs, or the node's MagicDNS name; Digby is not involved | The sharer |

**The split route stays**, pointing at Digby: it is what gives this tailnet the name, and Digby's answer follows the device inventory. The health check "Split routes answered" verifies that Digby answers it, so a route whose target answers nothing (today's state) shows up as a to-do item instead of silently failing.

### 4.16 IPv6 support

Digby itself supports IPv6, independent of what any one deployment binds. Wherever a host has IPv6 addresses, the product handles them as it handles IPv4: listeners bind per address, with IPv6 literals alongside IPv4 ones in the same `addresses` list and no wildcard-only v4 assumption; the wire codec already carries AAAA with the same care as A (§6.19), and zones, records and views carry AAAA and IPv6 CIDRs wherever they carry A and IPv4 ones; the view classifier classifies v6 client sources and v6 prefixes; and every address parse, validation and comparison in `zones`, `machines` and `networks` accepts IPv6 literals. Deployments where the host has no IPv6 simply bind none — the 01 deployment does not: it binds `::1` as its only IPv6 address (Q27) — but the product is never limited to what one host happens to have.

## 5. Security

### 5.1 Administration

- **Auth:** rummage-ext-auth's password fill with the claim flow (`DIGBY_SETUP_TOKEN`); no default password. Social sign-in later if more people need access (Q16).
- **Person permissions** per extension (`digby.zones.edit`, `digby.networks.edit`, `digby.networks.write`, `digby.networks.mode`, `digby.networks.share`, `digby.certificates.manage`, …); the administrator holds everything in the first release; viewer and operator roles arrive with G5.
- **Every write is an action**, journaled with the person and the record versions. Writes to external systems (UniFi, Tailscale, Route 53) are **opt-in per integration** (a setting that is off until an administrator turns it on, with the scopes it needs listed), **admin-only** (`self.host.admin.write`, which also refuses read-only and MCP callers) and **audited** as actions whose records (`unifi-change`, `tailscale-change`, `public-plan`) hold the before and after.
- **Approvals** (rummage requests) for the irreversible: deleting a zone, retiring a DNSSEC key, deleting a public record, switching mode.
- **Admin UI and MCP reachability** are the operator's choice, set in config (**decided**, Q13): presets `lan-only`, `lan-tailnet` and `anywhere`, plus custom allowed networks (CIDRs). The default is **`lan-tailnet`**: the two networks the operator controls, reachable from a phone away from home over Tailscale, and not from the internet; `lan-only` is the stricter choice, and the allowed-networks list can exclude shared-in nodes' addresses (Digby knows them from the device inventory). Nothing is hard-wired: `anywhere` publishes the UI through whatever reverse proxy the operator runs, and rummage's auth, rate limits and audit apply unchanged. The address is `digby.homelab.cldmv.net` on Digby's own addresses with the wildcard certificate; MCP origin `https://digby.homelab.cldmv.net`.
- **Automation:** the same-machine read-only test key; a write-capable automation principal only if a need appears.
- **MCP server and REST API.** Digby has both, and nothing in them is hard-coded: every extension and driver contributes its own operations in its manifest, and rummage serves them (`rummage-ext-mcp` for MCP, G13 for REST and the shared operation registry). One declaration exposes an operation as an MCP tool and as a REST endpoint under `/api/v1/<ext>/…`, so the two never drift; an OpenAPI document is generated from the contributions. Auth is rummage's: the session, per-person API keys (created in Settings, scoped read or write, hashed at rest, revocable, audited; the single administrator's key in the first release), and OAuth as the MCP server already does it. Both share MCP's guard rails: rate limits, one audit row per call, credential scrubbing of every answer, read-only principals refused writes centrally, and on/off per operation by an administrator. Reachability follows the Q13 reach setting exactly as the UI does. The read operations ship in slice 1 and the writes with their slices (§6.17); writes go through the record rules as the person's own client write. Administrators only until G5.

### 5.2 DNSSEC

- **Validation** from the first release, in every mode: the root trust anchor with RFC 5011 tracking from a pinned IANA anchor; algorithms per RFC 8624; aggressive NSEC/NSEC3 caching (RFC 8198); `CD` honoured; `AD` only on validated answers; a clock-skew check that refuses to validate and raises a to-do item when the clock is off.
- **Signing** (later, **decided**, Q7): Digby signs the `homelab.cldmv.net` zone it serves directly, per view, with inline signing (ECDSAP256SHA256 default, Ed25519 offered), a CSK by default, NSEC3 with RFC 9276 parameters or compact denial (RFC 9824), keys in rummage secrets, rollovers on the scheduler with CDS/CDNSKEY (RFC 7344/8078). `cldmv.net` itself is signed by Route 53 (KSK in KMS, Route 53 signs) in the later Route 53 slice, with the DS at the registrar as a manual step.

### 5.3 Encrypted transports and certificates

- DoT (853) and DoH (`/dns-query` on Digby's HTTPS) on the LAN and tailnet listeners once certificates are Digby's (§11). DoQ when Node's QUIC is stable (G1).
- Upstream: recursion speaks plain DNS to authoritative servers; the optional forwarder mode uses DoT with a pinned SPKI or a CA-validated name.
- Certificates: issued and renewed by rummage's TLS extension through ACME (G8), wildcard by DNS-01 answered through the Route 53 driver with an IAM policy scoped to `_acme-challenge.*` TXT records only. Private keys live in rummage secrets or in files at mode 0600, never in records or logs.

### 5.4 Rate limiting and anti-amplification

Recursion only for admitted views; RRL on authoritative answers (per /24 and /56, `slip` 2); per-client outstanding and rate caps; global outstanding cap; per-upstream caps and backoff; EDNS buffer 1232; minimal `ANY`; cookies (RFC 7873/9018) with exemption from RRL once proven; TCP idle timeouts, per-source caps, pipelining (RFC 7766), keepalive (RFC 7828). Generic buckets as a host leaf (G9).

### 5.5 Least privilege

Service user `digby`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`, matching bounding set, `NoNewPrivileges`, `ProtectSystem=strict` with the data dir and the certificate export directory as the only writable paths, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK`, `SystemCallFilter=@system-service`, `LockPersonality`, `RestrictNamespaces`; tailscaled operator for the sharing option; an ACL entry on the certificate files (§11). All emitted by `rummage deploy setup` from the app's deploy defaults (G3). There is **no interim hand-written unit** (**decided**, Q17): Digby waits for G3 in rummage#717.

### 5.6 Secrets

Only rummage secrets: UniFi API key and legacy credentials, the Tailscale OAuth client, the Route 53 IAM key, the ACME account key, certificate private keys, TSIG keys, DNSSEC keys, the cluster token. On the served host the store is keyed by the generated `secrets.key` or by `DIGBY_SECRETS_PASSPHRASE` as a systemd credential (rummage#748). The libraries receive credentials by injection from the extension that owns the secret; they never read the store. `rummage audit credentials` is in CI.

### 5.7 Zone transfer

AXFR/IXFR only with TSIG and an address ACL, out to configured secondaries and in for secondary zones; NOTIFY both ways; refused transfers logged with the key tried. Owned by the `transfer` extension, a late slice; the cluster replicates records instead.

### 5.8 Supply chain

Few dependencies pinned by lockfile; `rummage build --dependencies lockfile`; `npm ci --ignore-scripts`; the wire codec written in Digby (the fuzz target); `node:crypto` only; the `lib-*` packages are CLDMV's own, with their own tests and the same v4 CI; releases signed with `rummage release`; the deploy's `published` mode verifies the chain; CodeQL, dependency review, scorecard, provenance, `rummage audit`, `audit network`, `audit credentials`, and Digby's own security-review gate with a `.configs/security-surface.json` covering the codec, listeners, classifier, validation, TSIG/DNSSEC, the `networks` orchestrator's apply path, its drivers' write paths, the Route 53 driver and the cluster transport.

## 6. Extensions and libraries

### 6.1 The split (decided, Q12)

| Change | Why |
|---|---|
| **`encrypted` folds into `server`.** DoT, DoH and later DoQ are listener kinds: same codec, pipeline, classification and statistics. The `digby-ext-encrypted` repo is retired. | One listeners table, one UI, no seam on the hot path |
| **`networks` is added as the network orchestrator.** It owns the driver registry and the driver contract, IP management (networks and VLANs, addresses, reservations, fixed IPs), DNS settings per network, the mode switch, LAN sharing into the tailnet, and the network health checks. | UniFi and Tailscale are both network systems; one orchestrator with a vendor-neutral contract is what lets another router or VPN vendor plug in the same way |
| **UniFi and Tailscale become drivers of `networks`**, on standalone libraries: `digby-ext-networks-driver-unifi` (on `@cldmv/lib-unifi`) and `digby-ext-networks-driver-tailscale` (on `@cldmv/lib-tailscale`). `digby-ext-machines-driver-tailscale` is retired. Vendor specifics (Forward Domain rules, DHCP DNS settings, split routes, ACLs, Override, MagicDNS, shared-in nodes) stay inside the drivers; their checks surface through `health`. | The third-party API belongs in a library any CLDMV project can use; the rummage-specific part belongs in the driver; the policy, records, audit and UI belong in the orchestrator |
| **`machines` owns no drivers.** It takes its device sources from the networks drivers through the orchestrator. | One inventory, one place to plug a vendor in |
| **`health` is added**: the operational to-do (mode, listeners, UniFi, Tailscale, clock, certificates, replication), each finding with fix steps, staying until its check passes. | Every integration raises findings; one place shows them |
| **`proxy` is added** (Q25): the reverse proxy that replaces traefik, with per-source allow lists shared with views (§6.18). | Digby already owns the names, the views and the certificates; one list gating both DNS and HTTP can't drift |
| **`wire` is added** (CLDMV/digby#42): the DNS wire codec leaves `server` and becomes its own extension at `self.wire.*`, published as 42 leaves; `server`, `zones`, `transfer`, `dnssec`, `resolver` and `public` declare it as a requirement and nothing deep-imports it (§6.19). | Five extensions share the codec and its unit, property and fuzz suites; one repo keeps them together, proves the surface against the composed tree (`composeTestHost`), and leaves the codec liftable into a standalone library later |
| `public` and `public-driver-route53` stay but move later; `blocking`, `dnssec`, `transfer`, `cluster`, `dhcp` are later slices. | Q3, Q5, the mode model |

The extensions: `wire`, `server`, `zones`, `views`, `resolver`, `logs`, `health`, `networks`, `networks-driver-unifi`, `networks-driver-tailscale`, `machines`, `public`, `public-driver-route53`, `cluster`, `dnssec`, `transfer`, `blocking`, `dhcp`, `proxy` (nineteen) plus the `digby` app; the libraries `lib-unifi`, `lib-tailscale`, `lib-route53`.

Conventions shared by all of them: the sectional layout (`src/api/<slug>/`, `src/view/<slug>/`, `src/lib/`, `sql/`), leaf names by directory nesting (`self.zones.record.set`, never camelCase), `platforms: ["web"]`, `requires` listing the rummage packages each builds on, record types as global lowercase hyphenated names with `scope: "org"` and `history: "all"`, manifest `public` / `symbols` / `permissions` / `emits` / `subscribes`, an `operations` contribution (the MCP tools and REST endpoints the extension or driver owns, §6.17; a driver contributes reads only, every write goes through its orchestrator), a `docs/<slug>.md` on the rummage template, and `tests/*.test.vitest.mjs` composed through `composeTestHost`.

### 6.2 The libraries

Standalone repositories under CLDMV, plain ESM, no dependency on rummage or Digby, credentials and `fetch` injected, their own vitest suites with recorded fixtures, the v4 CI set, published to npm (**decided**, point 5).

**`CLDMV/lib-unifi` → `@cldmv/lib-unifi`.** One interface over two APIs: the official UniFi Integration API (an API key created on the console) is preferred; the legacy controller API that `CLDMV/unifi-cli` uses (`lib/api/*`: login with a local account, `rest/networkconf`, `rest/user`, `v2/api/site/{site}/client/{id}`, `static-dns`) fills in what the official API cannot do. Callers see one surface:

```js
import { createUnifi } from "@cldmv/lib-unifi";
const unifi = createUnifi({ baseUrl: "https://10.0.0.1", fetch, credentials: { apiKey, legacy: { username, password } }, tls: { spkiPins } });
await unifi.capabilities();                 // { networks: "official"|"legacy", clients: …, fixedIp: …, dns: { records: …, forward: "official"|"legacy"|"none" }, version }
await unifi.networks.list();                // every network/VLAN: id, name, vlan, cidr, gateway, dhcp { range, dns: [...], domain, leaseSec }
await unifi.networks.update(id, { dns: ["10.0.1.166"], domain: "homelab.cldmv.net" });
await unifi.clients.list({ active: true }); // mac, ip, hostname, network, fixed
await unifi.clients.fixedIp.set(mac, ip);
await unifi.dns.records.list(); await unifi.dns.forward.set({ domain, target });  // the Forward Domain rules
```

Every write takes `{ dryRun: true }` and answers the change it would make. `unifi-cli` later becomes a thin CLI on it.

**`CLDMV/lib-tailscale` → `@cldmv/lib-tailscale`.** The official REST API with an OAuth client (token exchange inside the library), plus tailscaled's LocalAPI over its Unix socket:

```js
import { createTailscale } from "@cldmv/lib-tailscale";
const ts = createTailscale({ fetch, oauth: { clientId, clientSecret, scopes }, tailnet: "tail935f4f.ts.net", localApi: { socket: "/var/run/tailscale/tailscaled.sock", fetch: unixFetch } });
await ts.devices.list();                    // owned and shared-in, with addresses, tags, routes, lastSeen, user, isShared
await ts.dns.get();                         // nameservers, split routes, search paths, magicDNS, override (as far as the API exposes it)
await ts.dns.splitRoutes.set({ "homelab.cldmv.net": ["100.64.178.0"] });
await ts.devices.routes.get(id); await ts.devices.routes.approve(id, ["10.0.0.0/23"]);
const { policy, etag } = await ts.policy.get(); await ts.policy.set(policy, { ifMatch: etag });
await ts.local.status(); await ts.local.prefs.patch({ AdvertiseRoutes: ["10.0.0.0/23"] });   // the LocalAPI, needs the operator
```

Read scopes and write scopes are separate clients or separately granted; the library never asks for more than the call needs.

**`CLDMV/lib-route53` → `@cldmv/lib-route53`** (**decided**, Q18): the same shape as the other two, plain ESM with injected credentials, no rummage or Digby dependency. It wraps AWS's official SDK client (`@aws-sdk/client-route-53`, installed at its latest version) rather than hand-writing SigV4 and the XML API; the library adds what Digby's callers need on top: scoped helpers (`ChangeResourceRecordSets` and `GetChange` first, for the slice-3 `_acme-challenge` TXT writes; `ListResourceRecordSets` and the DNSSEC calls when record management arrives), a dry-run plan of a change, change-status waiting, and errors mapped to typed codes. Credentials are passed in (never read from the environment or `~/.aws` by default). `digby-ext-public-driver-route53` is the driver built on it, plugged into the `public` orchestrator. It is built in **slice 3**, with its first consumer (§9): nothing earlier uses it, and a client library shaped before its consumer exists invents an API.

### 6.3 `digby-ext-server` — listeners, query engine

**Purpose.** The data plane: sockets, view classification, RRL and cookies, authoritative lookup over snapshots, cache, hand-off to the resolver, counters. The codec is not its own any more — `digby-ext-wire` owns it (§6.19) and server consumes it through `self.wire.*`. The only extension that touches the network, through `self.host.net.*` (G1, G2).

**Records.** `listener` (`name`, `kind` ∈ `udp`/`tcp`/`tls`/`https`/`quic`, `addresses[]` or selectors `lan`/`tailnet`/`all`, `port`, `tls` (`host` or a certificate ref), `views[]`, `retryBind`, `enabled`; DoH adds `path`); `server-policy` singleton (`ednsBufferSize` 1232, `minimalAny`, `cookies`, `rrl { window, responsesPerSecond, slip, exempt[] }`, `tcp { idleMs, maxPerSource, maxTotal }`, `serveStale { enabled, maxTtl }`, cache sizes and TTL bounds, `adminReach` preset and CIDRs, Q13).

**Leaves and commands.** `self.server.snapshot.set(kind, snapshot)` (a scoped symbol granted per kind to `zones`, `views`, `dnssec`, `blocking`), `self.server.status()`, `self.server.cache.flush`, `self.server.cache.dump`, `self.server.lookup({ name, type, view, client })` (a synthetic query for the UI tester and the compare tool); commands `server.listeners.apply`, `server.stats`, `server.lookup`.

**UI.** "Server": listeners with bind state per address (including "waiting for the port"), qps and cache tiles, the query tester, the policy section.

**Permissions.** `digby.server.listeners.edit`, `digby.server.policy.edit`, `digby.server.cache.flush`.

**Codec.** `digby-ext-wire`'s, not server's (§6.19): RFC 1035 with compression and pointer-loop guards; EDNS(0) with cookie, tcp-keepalive, padding and extended-error options; typed rdata for A, AAAA, NS, CNAME, SOA, PTR, MX, TXT, SRV, CAA, NAPTR, TLSA, SSHFP, HTTPS/SVCB, DS, DNSKEY, RRSIG, NSEC, NSEC3, NSEC3PARAM, CDS, CDNSKEY, TSIG, OPT, and `TYPEnnn` for the rest; strict lengths, no allocation on claimed counts, per-transport size caps. Server consumes it through `self.wire.*`, declares it as a requirement (CLDMV/digby#42), and deep-imports nothing.

### 6.4 `digby-ext-zones`

**Records.** `zone` (`name`, `kind` ∈ `primary`/`secondary`/`forward`/`stub`, `views[]`, `soa`, `serialPolicy`, `serial` (server-written), `defaultTtl`, `dnssec` ref, `forward { to[], views[] }`, `secondary { primaries[], tsigKey }`, `disabled`); `rrset` (`zone`, `name`, `type`, `view` (null = all), `ttl`, `records[]`, `comment`, `source` ∈ `manual`/`machines`/`transfer`/`acme`). Validate: CNAME exclusivity per view, apex SOA and NS, wildcard rules, rdata parsed by the codec's presentation parser, `source` other than `manual` writable only by the owning module, a manual record in the same view overriding a sourced one.

**Leaves and commands.** `self.zones.list/get`, `self.zones.record.set/remove`, `self.zones.compile()` (debounced on `data:changed`), `self.zones.import.file`, `self.zones.import.axfr` (the cutover import; the exchange through G2), `self.zones.export`, `self.zones.check`. Serial bump per compile that changes a view's content.

**UI.** "Zones": zone tree, RRset table with view chips, inline edit with field-level answers, import/export, lint, the history drawer.

**Permissions.** `digby.zones.view`, `digby.zones.edit`, `digby.zones.import`, `digby.zones.delete` (a request).

### 6.5 `digby-ext-views`

**Records.** `view` (`name`, `order`, `match { sources[], listeners[], networks[] (refs into `networks`, mode 2), default }`, `recursion`, `transfers`, `blocking`, `description`); seeded `lan`, `tailnet`, `public` (default, recursion refused).

**Allow lists** (slice 3b, #47/#48). A view (or a source or listener rule inside it) can carry a name allow list with wildcards (`*.test.homelab.cldmv.net`). The list is the one source of truth for both sides: `server` answers NXDOMAIN (or REFUSED, per view) for a name outside it, the zone wildcard included, and the proxy (§6.18) refuses the same names at the handshake. A name can therefore never be resolvable but blocked at the proxy, or the other way round. Pods behind k3s CoreDNS reach Digby as CoreDNS's address, so they get a dedicated listener classified into its own view; the same listener idea gives the LLM server's pods a different list than its host, which shares their tailnet address.

**Leaves.** `self.views.list`, `self.views.classify({ client, listener })` (tester only), `self.views.compile()`, `self.views.allowed({ view, name })` (used by `server` and `proxy`). **UI.** ordered list, CIDR editor with overlaps, "who am I" tester. **Permissions.** `digby.views.edit`.

### 6.6 `digby-ext-resolver`

**Purpose.** Full recursion from the root servers with QNAME minimisation (RFC 9156), negative caching (RFC 2308), NXDOMAIN cut (RFC 8020), aggressive NSEC (RFC 8198), DNSSEC validation (RFC 4033-4035, 5155, 6840) with RFC 5011 anchor tracking, prefetch, serve-stale (RFC 8767), upstream health and EDNS fallback, in every mode from the first release (**decided**, Q4). Forwarders are an option: globally (`mode: "forward"`) or per zone (`forward` zones), over UDP/TCP or DoT with SPKI pins; never the default.

**Records.** `resolver-policy` singleton (`mode` ∈ `recursive`/`forward`, `forwarders[]`, `qnameMinimisation`, `validation` ∈ `on`/`permissive`/`off`, TTL caps, `prefetch`, `serveStale`, `ipv6`, `maxOutstanding`, `perClientOutstanding`, `upstreamTimeoutMs`, no ECS ever); `trust-anchor` records.

**Leaves.** `self.resolver.resolve(question, { view })` (the server's miss path), `self.resolver.lookup({ name, type, trace: true })` (admin debugger). **UI.** "Resolver": mode, forwarders, validation state (anchor, last RFC 5011 check, clock skew), trace tester, upstream health. **Permissions.** `digby.resolver.edit`.

### 6.7 `digby-ext-logs`

Query logs are telemetry in the series store (G4), never records. **Defaults** (**decided**, Q14): raw rows with the client address kept **7 days**, aggregates (per-minute roll-ups: qps, rcode mix, top names, top clients, cache hit ratio, per view, per listener) kept **90 days**; both retentions are settings an administrator changes (`rawRetentionDays`, `aggregateRetentionDays`), plus `sampleRate` and `anonymiseClients` (off by default).

**Leaves and commands.** `self.logs.append(batch)` (identity-scoped to `server`), `self.logs.query`, `self.logs.stats`, `self.logs.tail`, `self.logs.compare.run({ a, b, names, views })` → a `compare-report` record (differences by rcode, answer set, flags, latency; expected differences marked), `self.logs.compare.names.fromLog`. `a` and `b` are `address[:port]`, so the shadow period's `.166:5353` compares against `.165:53`. **UI.** stat tiles, live tail, top-N, the compare page. **Permissions.** `digby.logs.view`, `digby.logs.compare`, `digby.logs.retention`.

### 6.8 `digby-ext-networks` — the network orchestrator

**Purpose.** The one extension that owns the network. It defines the driver contract and holds the driver registry; it is the IPAM (networks and VLANs, addresses, reservations, fixed IPs); it holds the DNS settings per network, the mode switch, LAN sharing into the tailnet, and the network health checks (surfaced through `health`). Vendor specifics stay inside the drivers (§6.9, §6.10); the orchestrator never names a vendor in its policy, only in what a driver reports.

**The driver contract.** A driver is placed at `networks.driver.<name>.*` (so it holds the `driver` surface by placement, like rummage's own store and storage drivers) and registers at activate:

```js
self.networks.driver.register({
	id: "unifi",                       // one driver per id; the record `network-driver` mirrors it
	kind: "lan" | "overlay",           // what the networks it reports are
	capabilities: () => ({ networks: "read" | "write" | "none", devices, fixedIp, dnsSettings, forwardRules, routes, policy, splitDns, version }),
	report: () => ({ networks: [...], devices: [...], routes: [...], dns: {...} }),   // the normalised shapes below, read-only
	plan: (change) => ({ steps: [...], before, after }),                             // a dry run of one normalised write
	apply: (plan) => result,                                                         // the write; reachable only through the orchestrator's audited apply
	check: () => [{ id, severity, summary, steps }]                                  // the driver's own health checks with fix steps
});
```

Normalised shapes: `network { id, name, vlan, cidr, gateway, dhcp { range, leaseSec }, dns { servers[], domain }, kind }`; `device { id, hostname, addresses { lan[], overlay[] }, mac?, tags[], online, shared, seenAt }`; `route { prefix, via, advertised, approved }`; `dns { resolvers[], splitRoutes {}, override, magicDns, searchPaths[] }`. Normalised writes a driver may support: `network.dns.set`, `client.fixedIp.set`, `dns.forward.set`, `dns.splitRoute.set`, `route.advertise`, `route.approve`, `policy.grant`. A driver that lacks a capability answers `none` and the orchestrator shows the manual fix step instead of the button. The contract ships as a conformance suite in the orchestrator's `testing` map (`describeConformance`), so every driver proves the same behaviour.

**Records.** `network`, `address` and `reservation` (§4.10: `network { name, driver, externalId, vlan, cidr, gateway, dhcp, dns { servers[], domain } as handed out, digbyManaged, shared }`, `address { network, ip, kind ∈ fixed/reservation/lease/static/digby/gateway, mac, machine, rrsets[], state, seenAt }`); `network-driver` (per driver: `id`, `kind`, `capabilities` (server-written), `version`, `writesEnabled`, `lastSync`, `lastError`); `network-change` (every external write: `driver`, `kind`, `target`, `before`, `after`, `plan`, `appliedAt`, `by`); `network-share` (`network`, `people[]`, `devices[]`, `state ∈ planned/advertised/approved/granted/verified/failed`, timestamps); `network-policy` singleton (`mode ∈ 1/2`, `digbyAddresses` per mode, `forwardDomains[]` beyond Digby's own zones, `searchDomain`).

**Leaves and commands.** `self.networks.sync()` (every driver's `report` → `network`, `address` and the device list), `self.networks.list`, `self.networks.devices.list()` (merged from every driver, with the driver id and `shared`: the `machines` source), `self.networks.address.list({ network, free: true })`, `self.networks.address.assign({ machine, network, ip? })`, `self.networks.dns.plan(network, { servers, domain })` / `.apply(plan)`, `self.networks.forward.plan/apply` (the Forward Domain rules for every Digby domain, computed from `zones`), `self.networks.mode.plan(mode)` / `.apply(plan)` (a request: all networks at once; mode 1 = gateway as DNS + forward rules + search domain; mode 2 = Digby nodes as DNS + rules removed), `self.networks.share.plan(network, { people, devices })` / `.apply` / `.revoke` / `.verify` (the four steps of §4.9, each through the Tailscale driver), `self.networks.driver.list()` (metadata only, never the driver object), `self.networks.check()` (the orchestrator's own checks plus every driver's, into `health`). Every apply: `self.host.admin.write`, the driver's `writesEnabled`, the plan recorded, the result verified by re-reading, a failed write a finding.

**Surfaces.** `surfaces: { driver: ["driver.register"], backend: ["backend.select"], config: ["config.set"] }`; `public: ["list", "devices.list", "address.list", "driver.list", "check"]`.

**UI.** "Networks": per-network address map (used, fixed, free), the machine and the records each address carries, the network's DNS settings with "what Digby would hand out in mode 1 / mode 2", the mode switch with its plan, shares with their four-step state, drivers with capabilities, version and writes state, the change log.

**Permissions.** `digby.networks.view`, `digby.networks.edit`, `digby.networks.write` (external writes), `digby.networks.mode` (a request), `digby.networks.share` (a request).

**Dependencies.** `machines`, `zones` (Digby's domains), `health`, secrets (each driver's own), the scheduler; G6 at the drivers.

### 6.9 `digby-ext-networks-driver-unifi`

Placed at `networks.driver.unifi`, built on `@cldmv/lib-unifi`. **Reports:** every network and VLAN with its DHCP DNS servers and domain, clients with addresses and fixed IPs, the Forward Domain rules, the controller's capabilities and version. **Writes it can apply** (opt-in, admin, audited, through the orchestrator): `network.dns.set` (the DHCP DNS servers and search domain of a network), `client.fixedIp.set`, `dns.forward.set` (Forward Domain rules). **Checks:** the Forward Domain capability (`official` / `legacy` / `none`), drift between the rules and Digby's domains, each network's DHCP DNS against the active mode, a pending console update, the legacy fallback in use. **Settings and secrets:** `baseUrl`, `site`, `writesEnabled`; the API key and the legacy account in its own secrets scope. **Needs** G6 (the controller is a private address with a self-signed certificate pinned by SPKI; the driver hands the bound fetch to the library). Later a DHCP lease source for `dhcp`.

### 6.10 `digby-ext-networks-driver-tailscale`

Placed at `networks.driver.tailscale`, built on `@cldmv/lib-tailscale`. **Reports:** devices owned and shared-in (with `shared`), the tailnet's DNS configuration (resolvers, split routes, Override, MagicDNS, search paths), routes advertised by 01 and approved, the policy file with its ETag. **Writes it can apply:** `dns.splitRoute.set`, `route.advertise` (tailscaled's LocalAPI on 01, which needs the operator step), `route.approve`, `policy.grant` (a clearly marked block, written with `If-Match`, refused if the file changed). **Checks:** the §4.9 table (split route, Override, MagicDNS, routes, ACLs, shared-in nodes, reachability, split routes answered). **Secrets:** the read-only OAuth client; the write client separately, enabled by its own opt-in (**decided**, Q15). **Needs** G6 (the LocalAPI over the Unix socket) and the operator step (G3).

### 6.11 `digby-ext-machines`

**Purpose.** Devices into `rrset`s: a `machine` per device with names and addresses per view. It owns no drivers: its sources are the networks drivers, read through `self.networks.devices.list()` after each `networks` sync (the orchestrator emits `networks:synced`, which `machines` declares in `subscribes`).

**Records.** `machine` (`driver` (the reporting driver's id), `externalId`, `hostname`, `name` (the admin's override), `hidden`, `names[]` (aliases, such as `quack.shellback.net`), `addresses { lan[], tailnet[] }`, `shared`, `tags[]`, `online`, `seenAt`); `machine-policy` singleton (`zone`, `nameTemplate` `{hostname}`, which address kinds go to which view: LAN addresses → `lan`, overlay addresses → `tailnet`). Shared-in nodes are named by the same template as owned devices; `name`, `names[]` and `hidden` are the admin's and survive a sync (**decided**, Q15).

**Leaves and commands.** `self.machines.sync()` (diff the orchestrator's device list, write `machine` and the derived `rrset` records with `source: "machines"` in one action), `self.machines.list`, `self.machines.rename(id, name)`, `self.machines.alias.add(id, name)`, `self.machines.hide(id)`. **UI.** "Machines": device table (driver, owned/shared, online, names, addresses, views), rename, alias, hide. **Permissions.** `digby.machines.edit`, `digby.machines.sync`. **Dependencies.** `networks`, `zones`.

### 6.12 `digby-ext-health` — the operational to-do

**Purpose.** One list of findings with fix steps, each staying until its check passes: the active mode and its costs; listeners not bound (and why); the networks drivers' checks (the UniFi capability and drift between what Digby expects and what UniFi hands out, §6.9; the §4.9 Tailscale checks, §6.10); clock skew; certificate expiry and renewal failures; replication lag; a deploy's `self.host.problems.raised()` occurrences; the `localdomain` transition counter.

**Records.** `health-check` (registered by extensions: `id`, `owner`, `title`, `severity`, `interval`, the leaf path that runs it), `health-finding` (`check`, `state` ∈ `open`/`resolved`/`acknowledged`, `summary`, `steps[]` (exact, with the console path or the command), `since`, `lastChecked`). A finding resolves itself when its check passes; an acknowledgement silences it with a reason and a re-check date.

**Leaves and commands.** `self.health.check.register(id, path)` (identity-scoped; the registrant's own leaf by path, called back as the registrant), `self.health.run(id?)`, `self.health.findings()`. **UI.** "Admin to-do": findings grouped by area, fix steps inline, acknowledge. The MCP tool `health_findings` reads it. **Permissions.** `digby.health.view`, `digby.health.acknowledge`. This is the generic shape G12 proposes for rummage; Digby ships it first.

### 6.13 `digby-ext-public` and `digby-ext-public-driver-route53` (later)

**First step (certificates, §11):** a minimal orchestrator with the driver registry and one provider leaf, `self.public.acme.dns01` (`present({ name, value })`, `cleanup`), opened to the rummage TLS extension as its DNS-01 slot; the Route 53 driver, built on `@cldmv/lib-route53`, with only `ChangeResourceRecordSets` for `_acme-challenge.*` TXT records and `GetChange`, behind an IAM policy with `route53:ChangeResourceRecordSetsRecordTypes = ["TXT"]` and `route53:ChangeResourceRecordSetsNormalizedRecordNames` restricted to `_acme-challenge.homelab.cldmv.net` and `_acme-challenge.*.homelab.cldmv.net`, on the two hosted zones only.

**Second step (record management):** `public-zone` (`zone`, `provider`, `providerZoneId`, `ownership: { subtree: ["homelab"] }`, `syncMode`), `public-plan` (the diff with before/after, `status`), `public-record` (what Digby believes the provider holds); `self.public.plan/apply/adopt/drift`; deletions a request; adoption of the hand-made wildcard first. **Third step:** Route 53 DNSSEC signing of `cldmv.net` through the driver. **Permissions.** `digby.public.edit`, `digby.public.apply` (deletions a request), `digby.public.adopt`, `digby.certificates.manage` (shared with the TLS extension's own gate).

### 6.14 `digby-ext-cluster` (later)

Linking servers generically (**decided**, Q6): `cluster-node` (`name`, `role` ∈ `primary`/`node`, `addresses { lan[], tailnet[] }`, `publicKey`, `lastSeen`, `lag`, `serves[]` views derived from reachability), `cluster-policy` (`replicateTypes[]`, `heartbeatSec`). `self.cluster.join({ primary, token })` (one-time token shown once on the primary), `self.cluster.status()`, `self.cluster.promote(node)` (a request), replication through G7 over mutual TLS (G2). A non-primary node is read-only for configuration and fully live for queries; the `unifi` and `tailscale` extensions offer to add its addresses where clients can reach them.

### 6.15 Later extensions

`dnssec` (signing, §5.2), `transfer` (TSIG/AXFR/IXFR/NOTIFY for third-party secondaries), `blocking` (lists and rules per view; a future feature, not used today), `dhcp` (optional, with a second node), DoQ in `server`.

### 6.16 The `digby` app

```js
export default {
	name: "digby",
	title: "Digby",
	serverAuth: { fill: "password", cookieName: "digby_session", store: "auth.json", claim: { tokenEnv: "DIGBY_SETUP_TOKEN", tokenFile: `${dataDir}/setup-token` } }, // one administrator (decided, Q16)
	guiAuth: { fill: "password" },
	secrets: true, // the served host's generated key, or DIGBY_SECRETS_PASSPHRASE from a systemd credential
	server: { https: { key: "tls/key.pem", cert: "tls/fullchain.pem" } }, // the wildcard pair, hot-reloaded; issued by Digby itself from slice 3
	extensions: { fromDependencies: true },
	storage: { backupRoots: ["/var/lib/digby/backups"] },
	surfaces: {
		"@cldmv/digby-ext-server": { "snapshot.set": { zones: ["@cldmv/digby-ext-zones"], views: ["@cldmv/digby-ext-views"], signatures: ["@cldmv/digby-ext-dnssec"], blocking: ["@cldmv/digby-ext-blocking"] } },
		"@cldmv/rummage": { "tls.install": ["@cldmv/rummage-ext-tls"] },
		store: { backup: ["@cldmv/digby-ext-server"] }
	},
	callbacks: { "@cldmv/rummage-ext-tls": { dns01: "@cldmv/digby-ext-public" } },
	build: { dependencies: "lockfile", bundle: ["@cldmv/digby", "@cldmv/digby-*", "@cldmv/rummage", "@cldmv/rummage-*"] },
	app: async () => ({ extensions: [] })
};
```

Plus `install.json` (`digby`, `ghcr.io/cldmv/digby`, port 8443, `env: { DIGBY_SETUP_TOKEN, DIGBY_SECRETS_PASSPHRASE }`, `releaseKeys`), the onboarding steps (start, url, `network` (pick the listener addresses from the host's interfaces), `zones` (import), `views` (seeded from the detected LAN), `reach` (the Q13 preset)), the admin to-do mounted from `health`, the updater page, and MCP for the administrator.

### 6.17 Contributed operations: MCP tools and REST endpoints

Every operation is declared once in its owner's manifest (G13) and served both as an MCP tool and as a REST endpoint; the OpenAPI document is generated from these. The REST path is `/api/v1/<name>/<op path>`, where `<name>` is the extension's **short name**: by default derived from rummage's canonical id with the app's own plate dropped inside the app's API (`digby-ext-zones` → `digby.zones` → `zones`), or declared in the manifest. A driver nests under its parent: `/api/v1/networks/unifi/…`, `/api/v1/networks/tailscale/…`, `/api/v1/public/route53/…`. MCP tool names follow the same scheme with underscores: `zones_list`, `networks_unifi_capabilities`. Two extensions claiming one short name within the app refuse boot, naming both claimants; a breaking change to an operation goes under `/api/v2`. Reads are `GET`; writes are `POST`/`PUT`/`DELETE`, run as the person's own client write through the record rules, and refused to read-only keys and read-only connections. A driver contributes read operations only; its writes exist only as the orchestrator's audited apply. Reachability follows Q13.

| Owner | Read operations (slice) | Write operations (slice) |
|---|---|---|
| `server` | `server_status` `GET /status`; `server_lookup` `GET /lookup?name&type&view&client`; `listeners_list` `GET /listeners` (1) | `cache_flush` `POST /cache/flush`; `listener_set` `PUT /listeners/{name}`; `policy_set` `PUT /policy` (1, admin) |
| `zones` | `zones_list` `GET /zones`; `zone_get` `GET /zones/{name}`; `zone_records` `GET /zones/{name}/records?view`; `zone_export` `GET /zones/{name}/export?view`; `zone_check` `GET /zones/{name}/check` (1) | `rrset_set` `PUT /zones/{name}/records/{owner}/{type}`; `rrset_remove` `DELETE …`; `zone_create` `POST /zones`; `zone_import` `POST /zones/{name}/import`; `zone_delete` `DELETE /zones/{name}` (a request) (2) |
| `views` | `views_list` `GET /views`; `views_classify` `GET /classify?client&listener` (1) | `view_set` `PUT /views/{name}` (2) |
| `resolver` | `resolver_status` `GET /status`; `resolver_trace` `GET /trace?name&type` (1) | `resolver_policy_set` `PUT /policy` (2) |
| `logs` | `logs_recent` `GET /queries?since&name&client&view`; `logs_stats` `GET /stats?window`; `compare_reports` `GET /compare` (1) | `compare_run` `POST /compare` (1, admin: it writes a report); `logs_retention_set` `PUT /retention` (2) |
| `health` | `health_findings` `GET /findings`; `health_checks` `GET /checks` (1) | `health_run` `POST /run` (1, admin); `health_acknowledge` `POST /findings/{id}/acknowledge` (2) |
| `networks` | `networks_list` `GET /networks`; `addresses_list` `GET /addresses?network&free`; `devices_list` `GET /devices`; `drivers_list` `GET /drivers`; `networks_check` `GET /check`; `changes_list` `GET /changes` (2) | `address_assign` `POST /addresses`; `network_dns_plan` `POST /networks/{id}/dns/plan`; `change_apply` `POST /changes/{id}/apply`; `mode_plan` `POST /mode/plan`; `mode_apply` `POST /mode/apply` (a request); `share_plan` / `share_apply` / `share_revoke` / `share_verify` under `/shares` (requests where §4.9 says so) (2) |
| `networks-driver-unifi` (`networks/unifi`) | `networks_unifi_capabilities` `GET /capabilities`; `networks_unifi_forward_rules` `GET /forward`; `networks_unifi_networks_raw` `GET /networks` (2) | none: writes only through `networks` |
| `networks-driver-tailscale` (`networks/tailscale`) | `networks_tailscale_dns` `GET /dns`; `networks_tailscale_routes` `GET /routes`; `networks_tailscale_devices` `GET /devices`; `networks_tailscale_checks` `GET /checks` (2) | none: writes only through `networks` |
| `machines` | `machines_list` `GET /machines?driver&shared` (2) | `machine_rename` `PUT /machines/{id}/name`; `machine_alias_add` `POST /machines/{id}/aliases`; `machine_hide` `PUT /machines/{id}/hidden`; `machines_sync` `POST /sync` (2) |
| `public` | `acme_challenges` `GET /acme/challenges` (3); `public_zones_list` `GET /zones`; `public_plan_get` `GET /plans/{id}`; `public_drift` `GET /zones/{id}/drift` (5) | `public_plan` `POST /zones/{id}/plan`; `public_apply` `POST /plans/{id}/apply` (a request when it deletes); `public_adopt` `POST /zones/{id}/adopt` (5) |
| `public-driver-route53` (`public/route53`) | `public_route53_zones` `GET /zones` (3) | none: writes only through `public` |
| `cluster` | `cluster_status` `GET /status`; `cluster_nodes` `GET /nodes` (4) | `cluster_join` `POST /join`; `cluster_promote` `POST /nodes/{id}/promote` (a request) (4) |
| `dnssec` | `dnssec_status` `GET /zones/{name}`; `dnssec_cds` `GET /zones/{name}/cds` (5) | `dnssec_key_generate` `POST /zones/{name}/keys`; `dnssec_rollover_start` `POST /zones/{name}/rollover`; `dnssec_key_retire` (a request) (5) |
| `transfer` | `transfer_peers` `GET /peers` (5) | `transfer_notify` `POST /zones/{name}/notify`; `transfer_pull` `POST /zones/{name}/pull`; `tsig_key_generate` `POST /keys` (5) |
| `blocking` | `blocking_test` `GET /test?name&view`; `blocking_lists` `GET /lists` (future) | `blocking_rule_set` `PUT /rules/{id}`; `blocking_refresh` `POST /lists/{id}/refresh` (future) |
| `dhcp` | `dhcp_leases` `GET /leases` (optional) | `dhcp_reservation_set` `PUT /reservations/{mac}` (optional) |
| rummage's own | `certificates_list` (`rummage-ext-tls`, 3), the updater's `updates_status`, the MCP admin tab's operations: the framework's, not Digby's | — |

Internal leaves are never exposed by accident: an operation names exactly one leaf of its owner, and the registry refuses a leaf outside the owner's placement roots, as `mcp/tools` does today.

### 6.18 `digby-ext-proxy` — the front door (slice 3b, #49)

Digby replaces traefik as the reverse proxy on 01 (**decided**, Q25). The proxy holds 80 and 443 on every address 01 has, IPv4 and IPv6 alike (**decided**, Q27), once traefik is gone: TLS with the certificates Digby already owns (§11), served from rummage secrets in process, so the proxy needs no exported key file; port 80 redirects to HTTPS and answers ACME HTTP-01 if a non-wildcard name ever needs it. Termination only: the proxy terminates TLS, checks the names, and talks plain HTTP to the backend; SNI passthrough and re-encryption are a later feature (CLDMV/digby#50).

- **Routes.** `proxy-route` (`host` with wildcards, `backend { host, port, scheme }`, `listeners[]`, `headers`, `websocket`, `source` ∈ `manual`/`deploy`), replacing traefik's per-instance files under `/srv/traefik/dynamic`. Routes for rummage apps are kept current from what `rummage deploy` reports (instance added, port changed, instance removed) (#46); everything else is a hand-made route in the UI. On 01, backends stay on Docker-only or loopback ports; on the relay, the backends are the homelab's services reached over the tailnet, the way the nginx reaches them today.
- **Relays on other hosts** (Q26). The relay VPS runs an nginx vhost plus certbot per org today and fronts `ics.cldmv.net` (public); its nginx and certbot are replaced in slice 3b's second half (§9, Q26) — until then it stays as it is. 01 fronting those names is not the shape — 01 is not publicly addressed, and the relay exists to be the public front door — so the coverage is the same proxy extension deployed as its own rummage instance on the relay. What that takes: certificate automation by ACME DNS-01 through the provider driver instead of certbot (the relay's names are public; whether Route 53 holds the per-org zones is an open fact to confirm, §13 — if it does, #46's per-name challenge placement applies to them as well), routes and allow lists local to that instance (its own views; routes hand-made or fed by that instance's deploy reports — linking the instances comes with mode 2 if it is ever wanted), and no new routing code, since a backend is `{ host, port, scheme }` and the relay's backends are the homelab's services reached over the tailnet — what the relay's instance needs is that reachability, which the nginx already relies on, not different routing. The requirement that comes with it is explicit: the relay's instance must reach 01's app ports over the tailnet, the way the nginx does today — the tailnet node and that reachability are part of the relay slice's work, not of the proxy's routing. Beyond slice 3b's 01 work the increment is one more deployed instance and its certificate wiring (G3's deployment steps on a plain Linux host). Sized **small**, so it is slice 3b's second half (**decided**): its own acceptance — every nginx vhost answers identically through the relay's proxy, including the `/v1/vine` WebSocket upgrade and the long-lived SSE keepalive on `/v1/events` the nginx forwards today; ACME renews the relay's names; certbot retired — trailing within the slice, since it gates nothing on 01's traefik removal.
- **Allow lists** (#47). The per-source list from views (§6.5) gates every request: the TLS server name and the Host header must both be on the list and must agree; anything else is refused at the handshake, or with 421 (mismatch) or 403 (not allowed), and never reaches a backend. A source with a list is default-deny, and every refusal is logged with the source and the requested name.
- **Admin UI and DoH** become routes on the proxy (`digby.homelab.cldmv.net` → the admin listener, `/dns-query` → `server`), so 443 has one owner (Q22).
- **Parity before removal.** Every traefik router today has a matching route, verified by a compare that requests each hostname through both (`proxy.compare`, the HTTP counterpart of `logs.compare`), before traefik's container is stopped (§10 Phase 6).

**Leaves.** `self.proxy.route.set/remove/list`, `self.proxy.compare`, `self.proxy.status`. **Permissions.** `digby.proxy.edit`; routes from deploy are written by the app's deploy integration, not by hand.

### 6.19 `digby-ext-wire` — the DNS wire codec (CLDMV/digby#42)

The codec is its own extension, not a module of `server` (§6.3), and the surface has landed: **42 published leaves** (the manifest's `public` list) plus the host's own `activate`/`deactivate` — 44 in all. The messages side is `self.wire.decode`, `self.wire.encode` and `self.wire.messages.encode.capped` (the one encode-with-cap entry, kept as the explicit exception, CLDMV/digby#42); the transports side is `transport.encode`, `transport.limit`, `transport.udp.min`, `transport.udp.cap`, `tcp.frame`, `tcp.max` and `framer.create()` (TcpFramer is stateful, so callers get it through a factory); the presentation helpers are `record.parse`/`.format`, `ttl.parse`, `rdata.parse`/`.format`/`.encode`/`.decode`/`.generic`, `domain.parse`/`.format`/`.canonical`/`.key`/`.equal`/`.count`, `type.mnemonic`/`.parse` and `class.mnemonic`/`.parse`; TSIG is `tsig.append`/`tsig.size`; and the data leaves are `constants.type`/`.class`/`.rcode`/`.opcode`/`.edns.option`/`.svc.key`, `limits.message`/`.label`/`.domain`/`.domain.octets` and `errors.is`/`errors.codes`.

Every data leaf is a **zero-arg function** returning the frozen table or constant (`constants.type()`, `limits.domain()`, …), never an object export: under slothlet an object export composes as an unusable namespace wrapper — the table itself is not what a caller reads back — and the ext-host's own-leaf sanitizer lowercases all-caps filenames, so `TYPE`, `CLASS`, `RCODE` and `OPCODE` live at `constants.type`, `constants.class`, `constants.rcode` and `constants.opcode`. `errors.is(err)` is a **predicate**, not the class: WireError stays lib-internal, because a class leaf cannot be published at all (the own-leaf check sanitizes the file name while slothlet composes the class name — wire refused to load in any rummage host, rummage#1100), and `instanceof` is false across the composed boundary anyway (a composed instance is a separate module copy; the surface is settled under [CLDMV/digby#42](https://github.com/CLDMV/digby/issues/42)). The predicate answers by the error's own identity — the real brand inside this module graph, the name-plus-code shape for an error another module copy re-threw (zones' master-file decorator) — and refuses an invented code; `zones` uses it through the seam.

Publication is checked, not assumed: an entry that does not resolve on the composed tree is a load error, and the exemption covers only prefixes that are not themselves leaves ([CLDMV/digby#42](https://github.com/CLDMV/digby/issues/42)), so the `public` list cannot silently drift from the api tree; the compose test runs the real production host through `@cldmv/rummage/testing`'s `composeTestHost` and asserts both halves. The build is per-module compile-only (esbuild, `bundle: false`: every `src/` file compiled and minified in place, nothing merged, moved or duplicated), there is no CJS shim and nothing ships `dist/` — the manifest and the package's `exports` compose `src/` directly (the `./api` export is restored: `.` and `./api` both resolve to `src/api/wire/wire.mjs`), and `dist/` is a gitignored compile-check artifact only. The inner loops stay plain modules under `src/lib`; the unit, property and fuzz suites moved with the files, history included. It depends on no other digby extension, so it can be lifted into a standalone library later just by moving it. `server`, `zones`, `transfer`, `dnssec`, `resolver` and `public` declare it as a requirement and call `self.wire.*`; nothing deep-imports it. Not published to npm — consumers link it as `workspace:*` (CLDMV/digby#42).

## 7. Rummage gaps

Anything Digby needs that is not DNS-specific is a rummage capability, listed with the reason and an API sketch; each becomes a rummage issue once the plan is agreed. The libraries (`lib-unifi`, `lib-tailscale`) need nothing from rummage: they are plain ESM with injected `fetch` and credentials; the extension boundary needs G6. Ordered by when Digby needs it.

### G1. Network listeners as a host capability (`self.host.net.listen`)

**Why.** A DNS server is a UDP and TCP service on :53 (then :853, :443, later :67). Rummage offers one listener, the Fastify HTTPS server, and `rummage audit network` fails an extension that imports `node:net` or `node:tls` (`node:dgram` is absent from the list only because nothing needed it). Listeners are a framework concern the way the HTTP server is.

```js
network: { listen: [
	{ id: "dns-udp", proto: "udp", port: 53 }, { id: "dns-tcp", proto: "tcp", port: 53 },
	{ id: "dot", proto: "tls", port: 853, tls: "host" }, { id: "doq", proto: "quic", port: 853, tls: "host" }  // quic later
] }
const udp = await self.host.net.listen("dns-udp", { addresses: ["10.0.1.166", "100.64.178.0", "::1"], retryBind: true });  // v6 literals alongside v4 (§4.16)
udp.on("message", ({ data, from: { address, port }, to: { address } }) => …);  // one socket per address: `to` is known
await udp.send(buffer, { address, port }); udp.stats(); udp.rebind({ addresses }); await udp.close();
const tcp = await self.host.net.listen("dns-tcp", { addresses, backlog: 512, idleMs: 10_000, maxPerSource: 50 });
```

- `addresses` may be selectors (`lan`, `tailnet`, `all`) resolved against `self.host.net.interfaces()`, with `interfaces.onChange(fn)` to rebind; the resolved list carries both families, IPv6 addresses alongside IPv4 ones (§4.16), and the `from.address` a message arrives from classifies v6 client sources and v6 prefixes the way the view classifier does (§4.16). **`retryBind`**: an address whose port is in use is retried every second until it binds, and the listener reports `waiting` meanwhile; this is what lets Digby be configured for `.166:53` while Technitium still holds `0.0.0.0:53` and take the port the second it frees (§10).
- Options: `reusePort` (worker threads later), `broadcast` and per-interface binding (DHCP), `fd` adoption (socket activation).
- A listener is refused unless the manifest declares it; the declared ports feed G3 and the peer-port check (rummage#725). `audit network` adds `node:dgram` and recognises `self.host.net.*`.
- A sibling, `self.host.time.skew()` (`timedatectl`'s synchronised state over D-Bus), so a validating resolver can refuse to validate on a wrong clock.

### G2. Outbound raw network with a declared policy (`self.host.net.udp.exchange`, `tcp.connect`)

**Why.** A recursive resolver sends UDP and TCP (and TLS to a forwarder) to arbitrary addresses, private ones included (`100.100.100.100`, the gateway). The guarded fetch refuses private addresses by design and is HTTP. The resolver's traffic needs its own declared policy.

```js
network: { connect: [
	{ id: "upstream", proto: ["udp", "tcp", "tls"], ports: [53, 853], to: "any" },
	{ id: "forward", proto: ["udp", "tcp"], ports: [53], to: ["100.100.100.100/32", "fd7a:115c:a1e0::53/128", "10.0.0.1/32"] }
] }
const reply = await self.host.net.udp.exchange("upstream", { to: { address, port: 53 }, data, timeoutMs: 1500, source: "10.0.1.166" });
const conn = await self.host.net.tcp.connect("upstream", { address, port: 853, tls: { servername, spkiPins } });
```

A read-only principal's DNS query is a read; per-destination caps and a global outstanding cap live in the host; `audit network` recognises the leaves.

### G3. Privileged ports, capabilities, hardening and non-HTTP health in `rummage deploy` (into rummage#717)

**Why.** The deploy issues (#717, #723, #724, #748) say nothing about ports below 1024, capabilities, socket activation, unit hardening beyond "the launcher's hardening", supplementary groups or non-HTTP health probes; the unit template's settable fields are description, group, umask and environment. A DNS server cannot be installed by `rummage deploy setup` as it stands, and there is no interim hand-written unit (**decided**, Q17): this goes into #717 and Digby waits for it.

```jsonc
// the app's deploy defaults, overridable per instance in digby.deploy.json
{
	"service": {
		"user": "digby", "group": "digby",
		"capabilities": ["CAP_NET_BIND_SERVICE"],             // → AmbientCapabilities=, CapabilityBoundingSet=
		"harden": "network-service",                          // NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, PrivateDevices,
		                                                      //   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK, SystemCallFilter=@system-service, …
		"readWritePaths": ["/var/lib/digby/main", "/srv/certs", "/srv/traefik/dynamic"],   // the certificate export, written in place under ACL entries (§11)
		"credentials": { "DIGBY_SECRETS_PASSPHRASE": "/etc/digby/credentials/secrets-passphrase" },   // LoadCredential= (rummage#748)
		"postSetup": [{ "print": "sudo tailscale set --operator=digby", "why": "the LAN-sharing option drives tailscaled's LocalAPI" }]
	},
	"network": { "addresses": ["10.0.1.166", "100.64.178.0"], "ports": "from-manifest" },
	"health": [
		{ "kind": "http", "url": "https://127.0.0.1:8443/health", "bootChange": true },
		{ "kind": "http", "url": "https://[::1]:8443/health", "bootChange": true },   // v6 beside v4 (§4.16): both loopback families must serve
		{ "kind": "command", "run": "node tools/check-dns.mjs --server 10.0.1.166 --name health.homelab.cldmv.net --expect 10.0.1.165" }
	],
	"target": "systemd"   // "docker": cap_add (CAP_NET_BIND_SERVICE covers binds on both address families), user, sysctls net.ipv4.ip_unprivileged_port_start=0 (despite its name this sysctl sets the unprivileged-port floor for both address families; there is no net.ipv6.ip_unprivileged_port_start), network_mode host | macvlan
}
```

`rummage deploy setup` emits the unit (and optional `.socket` units for G1's `fd` adoption), prints the root steps it will not take itself (the operator, an address on an interface), and the health gate takes a list so a non-HTTP service proves it serves. The Docker compose the launcher prints and `install.json` gain the same blocks.

### G4. A series store for high-volume telemetry (`self.host.storage.series`)

**Why.** Query logs are thousands of rows a minute with a retention window; the host database is the records' home with history, backups and `VACUUM INTO` snapshots. Rummage owns storage; an extension opening its own SQLite file would be a second engine outside the framework's care.

```js
const queries = await self.host.storage.series.open("queries", { columns: {…}, indexes: [["at"], ["name", "at"]], retention: "7d", rotate: "1d", backup: "exclude" });
await queries.append(rows); await queries.query({ since, until, where, limit }); await queries.aggregate({ bucket: "1m", by: ["view", "rcode"], count: true });
await queries.retention.set("30d");   // an admin's change (Q14)
```

**Engine** (**decided**, [rummage#760](https://github.com/CLDMV/rummage/issues/760#issuecomment-7144901507)): rummage's existing SQLite engine, with no new engine.
- **Segments:** one database file per `rotate` period, a day by default, kept apart from the host database in a folder that backups and `VACUUM INTO` snapshots skip.
- **Expiry:** deletes a whole segment file, with no row deletes and no VACUUM.
- **Appends:** batched, one transaction per batch.
- **Queries:** time-range queries and `GROUP BY` roll-ups run in SQLite per segment and are merged across segments.
- **Interface:** callers see only `self.host.storage.series`, so the engine can change later without them changing.

Embedded NoSQL engines and DuckDB were ruled out, because they are native builds per platform.

### G5. A roles extension (`rummage-ext-roles`)

**Why.** Person permissions exist, the org's roles exist, but the role-to-permission matrix with its editor lives in `stratax-ext-roles`. Per-person accounts come after the first release (Q16); when they do, viewer and operator roles should be a rummage package, which also registers the MCP access resolver (`"read"` for viewers). Sketch: `role` and `role-grant` records, `self.roles.permit(id)`, the grant provider through `callbacks: { "@cldmv/rummage": { "permissions.grant": "@cldmv/rummage-ext-roles" } }`, a settings page over `self.host.permissions.list()`, `self.host.access.changed({ roles })` on edit.

### G6. Private-address, pinned-certificate and Unix-socket grants for the guarded fetch

**Why.** The UniFi controller is at `10.0.0.1` with a self-signed certificate, tailscaled's LocalAPI is a Unix socket, and the libraries take an injected `fetch`. The SSRF guard is right to refuse private addresses by default; what is missing is a declared, reviewable exception, hashed into the security surface like `outbound.readPost`.

```js
web: { private: [{ id: "unifi", hosts: ["10.0.0.1"], tls: { spkiPins: ["sha256/…"] }, why: "the UniFi controller's local API" }] }   // manifest; the app confirms it in config
const fetch = self.host.web.fetchFor("unifi");                 // a bound fetch the UniFi driver hands to lib-unifi
const unixFetch = self.host.web.unixFetchFor("/var/run/tailscale/tailscaled.sock");   // for lib-tailscale's LocalAPI
```

### G7. Server-to-server record replication (`self.host.records.replicate`)

**Why.** Rummage's change feed and sync are server-to-device. Linked Digby servers (§4.3) must receive the primary's records of every control-plane type and apply them as records. Configuration replication between instances of one app is generic; zone transfer is the DNS-specific part Digby keeps.

```js
const page = await self.host.records.replicate.since(cursor, { types: [...], limit: 500 });   // ordered versions with tombstones (primary)
await self.host.records.replicate.apply(page, { from: nodeId });                             // as the replica principal, primary wins (node)
```

### G8. TLS certificates: `rummage-ext-tls` with an ACME driver and a DNS-01 provider slot

**Why.** `self.host.tls.install` exists and the docs name "the package that renews certificates", but no such package does. Any rummage app may need certificates; Digby needs wildcards (`*.homelab.cldmv.net`) and single names, by ACME, and it is the one app that can answer DNS-01 itself (through the Route 53 driver, with an IAM policy scoped to `_acme-challenge.*` TXT records).

- `@cldmv/rummage-ext-tls`: `certificate` records (names, issuer, `notAfter`, `renewAt`, `install` targets), the `tls.install` grant, a renewal job (30 days before expiry, with findings 14 and 7 days out when it fails), **export targets**: write the key and the full chain to configured paths either by atomic rename (new files, configured mode) or **in place** (open, write, `ftruncate`, `fsync`: the inode survives, and with it the owner, mode and ACLs the files already have), with an optional `afterWrite` hook (touch a file, run nothing else), so services that read files pick a renewal up; the ACME directory configurable (Let's Encrypt staging first).
- `@cldmv/rummage-ext-tls-driver-acme`: RFC 8555 with DNS-01 and HTTP-01; the account key in secrets; a `dns01` slot an app fills by leaf path: `callbacks: { "@cldmv/rummage-ext-tls": { dns01: "@cldmv/digby-ext-public" } }` → `self.public.acme.dns01.present({ name, value })` / `.cleanup(...)`, each call audited.
- Keys: in rummage secrets, or the exported 0600 file; never in records, logs or answers.

### G9. Shared rate-limit buckets (`self.host.limits`)

`self.host.limits.take({ bucket: "doh", key: client, burst: 60, perMinute: 60 })` → `{ ok, retryAfterMs }`; identity-scoped bucket names, in-memory, `describe()` for the UI. The MCP server, the diag sink, DoH and the admin API each need one today.

### G10. Service-app scaffolding

`rummage create-app <name> --service` and `create-ext --service`: `platforms: ["web"]`, `serverAuth` with claim, `install.json`, a `<name>.deploy.json`, no Electron devDependencies.

### G11. Out-of-band alerts for headless apps

A plain SMTP driver for `rummage-ext-email` and a webhook notifier, so a finding nobody has the UI open for (a renewal failing, a node out of step, a listener that cannot bind) reaches a person.

### G12. An operational to-do (`rummage-ext-health`, from Digby's `health` and Stratax's admin to-do)

**Why.** Stratax keeps an admin to-do keyed on `self.host.problems.raised()` occurrences and its own setup items; `rummage-ext-todo` is the missing-data to-do for records; Digby's `health` extension (§6.12) adds registered checks with findings and fix steps that stay until the check passes. Every headless app wants that shape once. Sketch: `health-check` registered by leaf path (identity-scoped), `health-finding` records with `steps[]`, `self.health.run`, acknowledge with a re-check date, the raised occurrences folded in, a mountable "Admin to-do" view, and G11 for delivery.

### G13. A declarative REST API, unified with MCP tools: `rummage-ext-mcp` grows into `rummage-ext-api`

**Why.** Rummage has an MCP server with everything an API needs (per-tool access, read-only connections, on/off per tool, an audit row per call, credential scrubbing, OAuth, rate limits), but no declarative REST API: an extension that wants HTTP endpoints hand-writes `serverAttach` routes with none of those guard rails and no OpenAPI. Digby's REST API must be contributed by every extension and driver like its MCP tools are, with nothing hard-coded, so the machinery belongs in rummage. Per-person API keys, which quack#104 asks for, belong in rummage for the same reason: every served app wants a key a person creates, scopes and revokes.

**One extension, not two.** `rummage-ext-mcp` itself grows into the combined MCP + REST extension, renamed `rummage-ext-api`; no registry is added beside it. Its contribution point becomes `rummage-ext-api/operations`, and the existing `rummage-ext-mcp/tools` contributions keep working through an alias for a release (read as operations with `rest` unset).

**Sketch.**

```js
// rummage.manifest.mjs — one declaration, served as an MCP tool AND a REST operation
contributes: { to: { "rummage-ext-api/operations": { operations: [
	{
		name: "zones_list", title: "List zones", description: "Every zone the caller may see.",
		access: "read",                                              // "read" | "write"
		input: { type: "object", additionalProperties: false, properties: { view: { type: "string" } } },
		output: { type: "object", properties: { zones: { type: "array", items: { $ref: "#/components/schemas/Zone" } } } },
		leaf: "zones.api.list",                                      // one of the owner's own leaves; validated arguments as its one argument
		rest: { method: "GET", path: "/zones" },                     // served at /api/v1/<ext>/zones; omit for MCP-only, `mcp: false` for REST-only
		target: true                                                 // may add a safe `target` for the audit row, as mcp/tools does
	}
] } } }
```

- **Serving and naming.** `/api/v1/<name>/<op path>` from each owner's contributions, where `<name>` is the extension's **short name**: automatic by default, derived from the canonical id (`src/lib/ext-id.mjs`: `digby-ext-zones` → `digby.zones`) with the app's own plate dropped inside that app's API, so `zones`; a third-party extension keeps its plate (`acme.zones` → `acme/zones`). An extension or driver may declare its own short name in its manifest (`api: { name: "dns" }`); rummage has no such key today: `src/lib/ext-id.mjs` derives the canonical id from the package name only, the loader reads no `alias` or short-name field, and the "full name or alias" rule of rummage#550/#557 is about how a package names a peer (package name versus canonical id), not a name a package declares for itself, so the declared short name is part of this gap. A driver nests under its parent orchestrator by placement: `networks/unifi`, `networks/tailscale`, `public/route53`. MCP tool names follow the same scheme with underscores (`zones_list`, `networks_unifi_capabilities`), so a tool and its endpoint share a name. A short-name collision within an app refuses boot and names both claimants. `GET` for reads, `POST`/`PUT`/`DELETE` for writes; path and query parameters bound to `input`; answers with the HTTP status of an answer (`answerStatus`), never 500 for a refusal. A breaking change to an operation is published under `/api/v2` (an operation declares `version: 2`; `v1` keeps serving the old shape until its owner drops it). `GET /api/v1/openapi.json` (and per extension) generated from the registry, including the auth schemes.
- **Auth.** The session cookie (the app's own UI and anything on the same origin), **per-person API keys** (`Authorization: Bearer <key>`; created in Settings › API keys with a name and `read` or `write` scope, 256 random bits with a kind prefix, SHA-256 at rest, last-used tracked, revocable, every creation and revocation an audit row; an administrator may revoke anyone's; a key is never more than its person, exactly like an MCP connection), and OAuth through the MCP server's authorization server with `api:read` / `api:write` scopes. The test key keeps its same-machine read-only role.
- **Guard rails shared with MCP:** the same `act()` entry as the person, the read-only principal refused every write centrally, one audit row per call (`api__events`, the same shape as `mcp__events`), credential scrubbing of answers (`credential-undeclared`, the field scrub), rate limits from `self.host.limits` keyed per key or person, on/off per operation by an administrator (the owner's own toggle beside it), and a disabled operation gone from the OpenAPI document.
- **Reach.** The `/api/*` routes obey the app's reach setting the way the UI and `/mcp` do (Q13).
- **Unified by construction.** One extension, one declaration, two surfaces, one audit, one on/off list; a tool and an endpoint can never drift because they are the same object. The cost is the rename and the contribution-point alias for a release.

### Dependencies on work already planned (not gaps)

rummage#717 and children (`rummage deploy <name>`, layered config, snapshots in `/etc/digby/instances/`, systemd and Docker targets, signed images, source modes); #748 (the service user and `LoadCredential=`); #702, #725, #726 (health and boot-change checks, the peer-port check, admin-raise) — G3 extends #725 to UDP and non-HTTP ports and #702 to a probe list.

## 8. Install, deploy and update

- **Instance layout (systemd).** Service user `digby`; data dir `/var/lib/digby/main`; backups `/var/lib/digby/backups`; the deploy backup passphrase file `/etc/digby/backup-passphrase` (outside the data dir and the backup roots); the resolved snapshot `/etc/digby/instances/main.json`; the live bundle in A/B slots; secrets by the generated `secrets.key` or `DIGBY_SECRETS_PASSPHRASE` as a systemd credential; certificate exports into `/srv/certs` in place, under ACL entries for the digby user.
- **Deploy config.** `digby.deploy.json` beside the app config with the G3 `service`, `network` and `health` blocks, the admin HTTPS `host`/`port` (Digby's addresses, port 8443 in the first release — 443 on `.166` once traefik is narrowed, Q22), `dataDir`, `target`; layers per rummage#723; `--dry-run` shows what changes. One instance: `rummage deploy main`.
- **First install.** `rummage deploy setup` (sudo: user, groups, dirs, unit, credential, snapshot; prints the operator and address steps) → `rummage deploy main` (preflight, backup, build, slot swap, health incl. the DNS probe, render check) → claim with the setup token → onboarding (network addresses, zone import, views, reach preset).
- **Updates.** The same command; `workspace` mode while Digby is developed on 01, `published` once releases are signed (`rummage release`), the updater's dashboard for notify/auto-patch. A new node (§4.3): the same install on another server, then `cluster.join`.
- **Docker target.** Through the self-hosting kit for hosts that want it: the compose carries the capability and network settings (G3); host networking or macvlan so views see real client addresses.
- **Backups.** The deploy's verified backup before every deploy; the onboarding backup panel for a full encrypted backup (database, secrets incl. keys, registry, the extensions' dirs); daily scheduled database backups into the backup root; the series store excluded by declaration.

## 9. Build order

Each slice ends in something that runs on 01 and is proven by §12. A slice does not start on workarounds for the rummage gaps it needs.

### Slice 0 — rummage and the libraries first

- Rummage: G1 (listeners with `retryBind`), G2 (outbound), G3 (into #717: capabilities, hardening, groups, operator step, non-HTTP health), G4 (series store), G13 (the operation registry, REST serving, OpenAPI, per-person API keys: the first release's read endpoints need it); G6 and G12 may land here or with slice 2.
- Libraries, in parallel and standalone: `lib-unifi` (official API, legacy fallback, capability probe, dry-run writes) and `lib-tailscale` (REST with OAuth, LocalAPI, read/write scope separation), each with recorded fixtures and the v4 CI set.
- Digby: `digby-ext-wire` (§6.19) with unit, property and fuzz tests, standing alone; the app shell as a served app with the password fill and the claim; `rummage deploy` on scratch instances through rummage#719's harness.

### Slice 1 — the first release: mode 1, replacing Technitium

`server` (UDP/TCP listeners, EDNS, TC, RRL, cookies, cache, authoritative lookup, miss hand-off, `retryBind`, the straggler listener; the codec is `digby-ext-wire`'s, §6.19), `zones` (primary and forward zones, RRsets with history, master-file and AXFR import, export, lint, serials), `views` (`lan`, `tailnet`, `public`), `resolver` (**full recursion from the root with DNSSEC validation**, RFC 5011, negative caching, prefetch, serve-stale; forwarders optional), `logs` (series store, stats, live tail, the compare tool with `address:port` targets), `health` (listeners, clock, the configured mode and its costs, raised occurrences), the admin UI, one administrator with an API key, the slice-1 operations of §6.17 (every read as an MCP tool and a REST endpoint, the slice-1 admin writes), the deploy with the DNS health probe. The UniFi and Tailscale changes of the cutover are done by hand in this slice (§10).

Acceptance: the compare report against Technitium shows no unexplained differences over a week of names; the §12 conformance set passes; `delv`, `dig +dnssec` and `kdig` agree with Digby's `AD`; `dnssec-failed.org` is `SERVFAIL`; the gateway forwards Digby's domains and the internet works with Digby stopped; k3s resolves `ghcr.io` through Digby and through the gateway when Digby is stopped.

### Slice 2 — the network integrations

`networks` (the orchestrator: driver contract and registry, IPAM, per-network DNS settings, the mode switch, LAN sharing, network checks), `networks-driver-unifi` (capabilities, networks, clients, fixed IPs, DHCP DNS settings, Forward Domain rules, opt-in writes), `networks-driver-tailscale` (devices owned and shared-in, DNS configuration, routes, policy; the checks with fix steps including "split routes answered"; the split route and LAN-sharing writes behind separate scopes), `machines` (devices from the orchestrator, shared-in naming, rename/hide; `quack.shellback.net` as the worked example), `health` complete (the admin to-do), the `localdomain` retirement, the slice-2 operations of §6.17 (the write operations through the record rules; the drivers' read operations), G5 roles if per-person accounts are wanted by then.

### Slice 3 — certificates and encrypted transports

G8 (`rummage-ext-tls`, the ACME driver, the DNS-01 slot), `@cldmv/lib-route53` (standalone, built here with its first consumer, starting before G8 lands), `public` minimal with `acme.dns01` and `public-driver-route53` on that library limited to `_acme-challenge.*` TXT writes, the acme.sh takeover (§11), then DoT and DoH listeners on the LAN and tailnet addresses with the certificate Digby now owns. Why here: after the cutover, so DNS is stable and compared; independent of the mode; before linked servers, which each need a certificate for their admin UI and DoT; and because it touches files other services read (traefik, Quack) it deserves its own slice and its own rollback. acme.sh keeps working meanwhile, so nothing forces it earlier.

### Slice 3b — the front door: Digby replaces traefik

`proxy` (§6.18): TLS from Digby's own certificates, routes for every traefik router today, routes fed from `rummage deploy` (#46), the shared allow lists in views with NXDOMAIN filtering in `server` (#47, #48), the admin UI and DoH as proxy routes. It needs slice 3's certificates. Acceptance: `proxy.compare` shows every hostname answering the same through Digby and through traefik, a listed source reaches only its listed names (by SNI and Host) and resolves only those, and traefik is then removed (§10 Phase 6). The slice's second half is the relay's front door (§6.18, Q26): the same proxy on a second deployed instance on the relay VPS, replacing its nginx vhosts and certbot, with its own acceptance and nothing gating traefik's removal on 01.

### Slice 4 — linked servers (mode 2)

G7 replication, `cluster` (join, status, promote), `views` per UniFi network, the `networks` mode switch to mode 2 (every LAN-reachable node handed out, forward rules removed, through the UniFi driver), the split route listing every tailnet-reachable node (through the Tailscale driver), health findings for lag and reachability. A node is any server; nothing in this slice depends on what hardware it is.

### Slice 5 — later

`dnssec` signing of `homelab.cldmv.net` per view; `public` record management (adopt the wildcard, `homelab` subtree, plan/apply, deletions a request) then Route 53 DNSSEC signing of `cldmv.net` (Q7); `transfer` (TSIG secondaries); `blocking` (a future feature; not used today, Q5); `dhcp` (optional, only with a second node); DoQ; `lib-route53`'s `ListResourceRecordSets` and DNSSEC calls; G11 alerts.

## 10. Cutover from Technitium (mode 1)

Goal: no DNS outage, every step reversible by itself, the first release in mode 1, and nothing changed on Technitium, Tailscale, UniFi, systemd-resolved or k3s except as a listed step with its owner. Steps marked **[you]** are run by hand (root on 01, the UniFi console, the Tailscale admin console, Route 53); steps marked **[Digby]** happen in Digby's UI or through `rummage deploy`. The slice-2 `networks` orchestrator and its drivers later adopt what these manual steps configured and show drift from it.

### Phase 0 — prepare (no client sees a change)

1. **[you]** Export `homelab.cldmv.net` from Technitium as a zone file (or allow one AXFR to `127.0.0.1` for Digby's import). The zone list is confirmed (Q9): `homelab.cldmv.net` with its wildcard and the empty `quack.shellback.net`, nothing else; no query logs, no settings, nothing else is migrated. The container's compose or run definition is needed for Phase 5.
2. **[you]** Console check: the Network application's version and the presence of the Forward Domain record type (Settings › Policy Engine › DNS or Settings › Policy Table on 9.x). Apply the pending console update first if the version predates it (§4.2). Create a Forward Domain rule for a throwaway domain pointing at `10.0.1.165` and confirm a LAN client resolves a name under it through the gateway, then delete it; that proves the mechanism before anything depends on it.
3. **[you]** Digby's LAN address: `sudo nmcli con mod "Wired connection 1" +ipv4.addresses 10.0.1.166/23` then `sudo nmcli con up "Wired connection 1"` (a brief blip on `eno1`; confirm with `ip -br addr`), and a UniFi fixed IP or reservation for `10.0.1.166` so DHCP never hands it out (`.166` answers no ARP or ping today). Later this becomes a `networks`/`unifi` fix step (§4.10).
4. **[you]** In Portainer, stack `traefik-proxy`: change the traefik container's port bindings from `0.0.0.0:80`/`:443` and `[::]:80`/`:443` to `10.0.1.165:80`/`:443`, `100.64.178.0:80`/`:443` and `[::1]:80`/`:443` (Q27; never `[::]` — `::1` is the only IPv6 address 01 has) — and redeploy the container. Required before Digby can use `.166:443` (DoH, and the admin UI on 443 if wanted); the first release's admin UI is on `.166:8443`, so this step can wait until slice 3, but doing it now removes the dependency. It is interim: traefik is removed in Phase 6. Rollback: restore the bindings.
5. **[you]** `rummage deploy setup` as root once G3 has landed in rummage#717 (user `digby`, groups, `/var/lib/digby/main`, `/etc/digby/instances/main.json`, `/etc/digby/backup-passphrase`, the secrets credential; it prints the operator step, which is not needed until slice 2).
6. **[Digby]** `rummage deploy main`; claim at `https://10.0.1.166:8443/` with the setup token; onboarding: listeners `10.0.1.166:53`, `10.0.1.165:53` and `100.64.178.0:53` configured with `retryBind` (they wait: Technitium holds `0.0.0.0:53`), plus a shadow listener `10.0.1.166:5353` that binds now; every listener binds IPv6 alongside IPv4 on the same ports — `::1` only (Q27: 01 binds no tailnet IPv6 address, because the host doesn't carry one), never `[::]` — and Technitium keeps `[::]:53` until Phase 3, so the v6 binds wait under `retryBind` with the v4 ones; views seeded with `10.0.0.0/23` and `100.64.0.0/10`; reach preset `lan-tailnet`.
7. **[Digby]** Import `homelab.cldmv.net` (file or AXFR); add the reverse zones `0.0.10.in-addr.arpa` and `1.0.10.in-addr.arpa` (new: Technitium has none) with PTRs for the known hosts; set the `tailnet` view variants (`*.homelab` and the apex → `100.64.178.0`); create the one-name zone `quack.shellback.net` in the `tailnet` view with A `100.94.135.85` (§4.15; slice 2 takes it over from the machine alias); add the forward zones `tail935f4f.ts.net → 100.100.100.100` and `localdomain → 10.0.0.1` (the month-long transition, §4.11); resolver mode recursive (or, for a like-for-like first compare, the forwarders Technitium uses, then back to recursive).
8. **[Digby]** Run the compare: `logs.compare` with `a = 10.0.1.165:53`, `b = 10.0.1.166:5353`, a synthetic name list (every zone name, the wildcard at a few labels, the reverse lookups, a top-1000 public list, the names the homelab's own services use). Fix every unexplained difference; mark the expected ones (the reverse zones Technitium lacks, `localdomain`).

Rollback: none needed; nothing points at Digby.

### Phase 1 — the gateway becomes the clients' resolver (resilience first, Technitium still the authority)

9. **[you]** UniFi: Forward Domain rules `homelab.cldmv.net → 10.0.1.165`, `0.0.10.in-addr.arpa → 10.0.1.165`, `1.0.10.in-addr.arpa → 10.0.1.165` (the reverse rules answer nothing until Digby takes over, which is fine). Then, on every network: DHCP DNS server → the gateway (UniFi's "Auto"), domain name `homelab.cldmv.net`. Clients move as leases renew. From here an outage of 01 costs homelab names only, with Technitium still answering them. Rollback: DHCP DNS back to `10.0.1.165`, the same lease timing.
10. **[you]** Verify on a renewed client: `resolvectl status` (or the OS equivalent) shows the gateway; `dig quack.homelab.cldmv.net` → `10.0.1.165`; `dig example.com` works with Technitium stopped for a minute (optional; it proves the point).

### Phase 2 — shadow (one to two weeks)

11. **[Digby]** Re-run the compare from a growing name list; watch the shadow listener's `SERVFAIL`s and slow upstreams; deploy at least one update through `rummage deploy main` to prove the health gate and the rollback on the live instance.
12. **[you, optional]** For a shadow with real clients and a zero-blip cutover, narrow Technitium's listener to `10.0.1.165:53` (its Settings › General › local end points). Digby's `retryBind` listener on `.166:53` then binds at once, test clients can be pointed at `.166`, and the Forward Domain targets can be moved to `.166` in Phase 3 **before** Technitium stops. Reversible by restoring Technitium's setting. Without this step the default path below has a sub-second blip and no real-client shadow.

### Phase 3 — cutover

13. **[you]** `docker stop <technitium>` (keep the container and its volumes). Digby's `retryBind` listeners take `10.0.1.166:53`, `10.0.1.165:53` and `100.64.178.0:53` within a second; the gateway's forward rules still point at `.165`, which Digby now answers, so no client notices beyond that second.
14. **[you]** UniFi: change the three Forward Domain targets `.165 → .166` and add `tail935f4f.ts.net → 10.0.1.166`. Verify through the gateway: `dig @10.0.0.1 quack.homelab.cldmv.net` → `10.0.1.165`; `dig @10.0.0.1 -x 10.0.1.165` → `01.homelab.cldmv.net`; `dig @10.0.0.1 01-homelab-cldmv.tail935f4f.ts.net` → `100.64.178.0`; `dig @10.0.0.1 example.com` works.
15. Rollback of 13–14: disable Digby's three `:53` listeners (one record change), `docker start` Technitium, forward targets back to `.165`.

### Phase 4 — pinned references and the tailnet

16. **[you]** k3s: `/etc/rancher/k3s/resolv.conf` → `nameserver 10.0.1.166` then `nameserver 10.0.0.1`; `kubectl -n kube-system rollout restart deployment coredns`; check a pod resolves `ghcr.io` and `quack.homelab.cldmv.net`. Rollback: the single line back, restart CoreDNS again.
17. **[you, optional]** Host 01's own resolver: a resolved drop-in `DNS=10.0.1.166 10.0.0.1`; after the restart, `resolvectl status` shows an empty Global and `100.100.100.100` only on `tailscale0`.
18. **[you]** Tailscale admin console › DNS › Nameservers › Add nameserver › Custom `100.64.178.0` › Restrict to domain `homelab.cldmv.net`. Override DNS servers stays **off**. The existing `quack.shellback.net → 100.64.178.0` route stays (§4.15) and now answers; no public record is added for it. Rollback: remove the new route (clients fall back to the public wildcard).
19. **[you]** Verify from a phone on cellular with Tailscale on: `quack.homelab.cldmv.net` → `100.64.178.0`; `quack.shellback.net` → `100.94.135.85`; from the LAN: `quack.homelab.cldmv.net` → `10.0.1.165` through the gateway; `dig @1.1.1.1 quack.homelab.cldmv.net` still → `100.64.178.0`.

### Phase 5 — bake and retire (two weeks later)

20. **[Digby]** The straggler listener on `.165:53` sees no clients, or each one is explained and fixed at its source (a static `resolv.conf`, a container's DNS option, the k3s file before step 16).
21. **[you]** Remove the Technitium container, image and volumes after archiving the zone export with the Phase 0 bundle; stop exposing `5380`.
22. **[Digby]** After about a month, when the `localdomain` forward zone's query counter has been zero for a week, remove the forward zone (§4.11).
23. **[Digby, slice 2]** The `networks` orchestrator reads the forward rules and DHCP settings through its UniFi driver, recognises mode 1 and reports drift from what Digby expects; through its Tailscale driver, its checks confirm the split routes answer.

### Phase 6 — the front door: retiring traefik (slice 3b)

24. **[Digby]** Configure the proxy's routes (one per traefik router, or imported from `/srv/traefik/dynamic`), bound to a test listener `10.0.1.166:8444`. Run `proxy.compare` against traefik on `10.0.1.165:443` for every hostname; fix every unexplained difference.
25. **[Digby]** Bind the proxy to `10.0.1.166:443` and `:80`; point the homelab records at `.166` view by view (the `lan` view first, then `tailnet`), watching traefik's access log go quiet.
26. **[you]** Stop the traefik container in Portainer (keep the stack). The proxy's `retryBind` listeners take `10.0.1.165:443`/`:80`, `100.64.178.0:443`/`:80` and `[::1]:443`/`:80` (Q27; 01 has no global IPv6, and no tailnet IPv6 address is bound — the host doesn't carry one) — within a second. Rollback: stop those listeners, start traefik.
27. **[Digby]** Turn on the allow lists for the sources that have one (the LLM server, its pods' listener), DNS and proxy together.
28. **[you]** After two weeks with no rollback, remove the traefik stack and `/srv/traefik/dynamic`; drop the reload hook from the certificate export (§11).

### What stays untouched

The acme.sh renewal until slice 3 (§11); traefik until Phase 6; Stratax's relay (`ics.cldmv.net` is public) until slice 3b's second half replaces its nginx and certbot with the proxy (§6.18, Q26); `tailscale set --accept-dns` on 01; the `tailscale0` link's MagicDNS routing; UniFi's DHCP role; the Route 53 wildcard; Technitium's configuration until its container is stopped in Phase 3.

## 11. Certificates: taking over from acme.sh

**Today.** acme.sh (`/srv/acme/acme.sh`) issues `*.homelab.cldmv.net` and the other SANs traefik presents (`*.01.homelab.cldmv.net`, `*.scopra.homelab.cldmv.net`, `homelab.cldmv.net`) by DNS-01 against Route 53, into `/srv/certs/homelab.key` and `/srv/certs/homelab.fullchain.pem`: `root:repo`, mode 0640, ACL `user:glmtest:r--` with mask `r--`, last renewed 2026-09-26. Readers (**decided**, Q20): the traefik container (bind-mount `/srv/certs` → `/certs`; it re-reads certificates only when its dynamic configuration reloads), Quack on `:18543` (`server.https`, hot-reloaded on change) and glmtest's Quack instances (through the ACL, hot-reloaded the same way). The takeover must keep the owner, the mode and the ACL, and give traefik a reload after each renewal while traefik runs. Once Digby's own proxy replaces traefik (§6.18, §10 Phase 6), the proxy serves the certificate from secrets, traefik drops off the reader list and the reload hook goes; the export stays for Quack and glmtest's instances.

**What Digby does** (slice 3, G8): obtain and renew wildcards and single names by ACME. A wildcard needs DNS-01, and the `_acme-challenge` TXT record is written wherever the name is authoritative (**decided**, #46): a public-DNS provider driver while Route 53 still holds the public zones — Route 53 first, through `digby-ext-public-driver-route53`, with an IAM policy limited to `ChangeResourceRecordSets` for `TXT` records named `_acme-challenge.homelab.cldmv.net` / `_acme-challenge.*.homelab.cldmv.net` (and the `shellback.net` equivalents when a certificate there is wanted) on those two hosted zones, plus `GetChange` — or Digby's own zone once Digby is the external, authoritative DNS for the name and answers the challenge from it with no outside provider. Each name picks which one; the automation is the same in both modes. That is the one Route 53 write the certificate feature needs; full record management stays in the later public slice.

**The relay's names are a second policy.** The policy above covers only the `homelab.cldmv.net` challenge names (and the `shellback.net` equivalents when wanted); `ics.cldmv.net` and the per-org names certbot fronts on the relay today are not covered, and when slice 3b's relay instance takes the ACME renewal over (§6.18) it gets its own: a separate IAM user or role whose policy is scoped to exactly the `_acme-challenge` TXT names of the relay's hosted zones plus `GetChange` — never the 01 policy widened. The relay is a public VPS, so Route 53 credentials there are the highest-exposure copy Digby holds: own credentials per instance, scoped to the challenge names only, and no list, zone-management or DNSSEC permission on either. Whether Route 53 hosts the per-org zones is an open fact to confirm first (§13): `ics.cldmv.net` itself sits inside `cldmv.net`, which Route 53 already hosts (Q3 plans that zone's DNSSEC signing there), so only the per-org domains are unknown; if they sit with another provider, the relay's driver is that provider's instead.

**Keys.** The ACME account key and every certificate's private key live in rummage secrets. The one copy outside the store is the exported key file at mode 0600, because traefik and Quack read files (the proxy that replaces traefik reads secrets directly); nothing about a key is ever in a record, a log, an answer or the admin UI.

**Takeover steps.**

1. **[you]** Create the IAM user or role with the scoped policy above; put its key into Digby's Route 53 driver through the UI (it lands in secrets). Give the digby user write access to the two files without changing anything else about them: `setfacl -m u:digby:rw-,m::rw- /srv/certs/homelab.key /srv/certs/homelab.fullchain.pem` (owner stays `root:repo`, mode 0640, `user:glmtest:r--` stays; the mask becomes `rw-` so digby's entry is effective, while the owning group's and glmtest's effective permissions remain `r--` because their own entries are `r--`), and `setfacl -m u:digby:rw- /srv/traefik/dynamic/<the file that references the certificate>` for the reload touch in step 6. G3's `ReadWritePaths` lists both directories so the hardened unit may write there.
2. **[Digby]** Issue against Let's Encrypt's **staging** directory a certificate with exactly today's SAN set, into Digby's own data dir; verify the chain with `openssl verify` against the staging root and the DNS-01 round trip (TXT present → validated → cleaned up) in the audit.
3. **[Digby]** Issue the production certificate the same way; install it for Digby's own HTTPS (`self.host.tls.install`). Digby now serves its admin UI and, once configured, DoT and DoH with it.
4. **[you]** Disable acme.sh's cron job (`acme.sh --uninstall-cronjob`), leaving acme.sh installed and its account and current certificate on disk.
5. **[Digby]** Turn on the export target `/srv/certs/homelab.key` + `/srv/certs/homelab.fullchain.pem` in **in-place** mode: each file is opened for writing, the new content written, the file truncated to the new length and fsynced, so the inode survives and the owner `root:repo`, the mode 0640 and the ACL are untouched (a rename would create a digby-owned file and drop the ACL); the chain is written after the key, and a reader that checks the pair (rummage's hot reload) keeps the old pair in service until both match. No marker inside the files (the formats are fixed); a `homelab.fullchain.pem.digby.json` sidecar names the certificate record and the time. The `afterWrite` hook touches the traefik dynamic file that references the certificate, which makes traefik's file provider reload and re-read `/certs`.
6. **[you]** Confirm the readers picked it up: `openssl s_client -connect 10.0.1.165:443` (traefik), the Quack origin on `:18543` and a glmtest Quack instance show the new serial and `notAfter`; `getfacl /srv/certs/homelab.key` still shows `root:repo`, 0640 effective, `user:glmtest:r--`. If traefik did not reload on the touch, restart the container in Portainer once and make that the documented step; Digby then raises a to-do item after every renewal until the hook is confirmed to work.
7. **[Digby]** Renewal runs 30 days before expiry; a failed renewal is a health finding 14 days before expiry and again at 7, with the fix steps (the IAM key, the Route 53 propagation, the ACME account); G11 delivers it out of band when that exists.
8. **Rollback**, at any step: turn the export target off (one setting), re-enable acme.sh (`acme.sh --install-cronjob`) and force one renewal (`acme.sh --renew -d '*.homelab.cldmv.net' --force`), which writes the same two paths; the readers notice nothing but a new serial.
9. **Retire acme.sh** after Digby has renewed once on its own (60–90 days), or keep it dormant as the rollback; either is fine, and the health page records which.

**Why slice 3.** After the DNS cutover, so the compare has run and the name service is stable; independent of the mode; before linked servers, each of which needs a certificate for its admin UI and DoT; and because it writes files other services read, it deserves its own slice and its own rollback. acme.sh works meanwhile, so nothing forces it earlier.

## 12. Testing

Rummage's layers apply (`composeTestHost`, `t.scheduler.run`, `t.serverAttach`, faults, the fake `web.hosts`), and DNS adds its own. Every probe that finds a bug becomes a committed test.

### Unit

- **Codec** (in `digby-ext-wire`, §6.19): round-trips for every supported RR type and `TYPEnnn`; compression and pointer-loop, forward-pointer and out-of-range cases; EDNS options; truncation at each transport's limit; presentation parsing with RFC 1035 escapes; a corpus from `dig`'s known-good output; property tests (`decode(encode(x)) = x`, `encode` never exceeds the declared size).
- **Compiler and classifier:** zone records in → view tables out (wildcards, CNAME-at-apex refusal, empty non-terminals, glue, per-view overrides, serial bumps); CIDR longest-prefix, listener tiebreak, IPv4-mapped IPv6, the default view, per-network views.
- **Resolver:** a fake authoritative tree through G2 fault injection: delegation following, QNAME minimisation steps, CNAME chains with a cap, negative caching, NXDOMAIN cut, lame delegations, EDNS fallback, timeouts and backoff, serve-stale bounds; validation against recorded signed zones (good, bogus, expired, NSEC3 opt-out, unknown algorithm → insecure); the forwarder mode with SPKI pins.
- **Records and rules:** every `validate` leaf's answers; `by.module` rules for `source`; requests for deletions and mode switches; history retained; the `machines` naming rules for owned and shared-in devices, rename and hide surviving a sync.
- **Integrations:** `lib-unifi` and `lib-tailscale` with recorded fixtures for both UniFi APIs and the capability matrix (`official`, `legacy`, `none`), dry-run plans equal to the applied changes, ETag refusal on the policy file; the orchestrator's opt-in gates (a write through a driver whose `writesEnabled` is off is refused and recorded as a finding), the driver contract's conformance suite (`describeConformance`) run against both drivers with recorded fixtures, the mode-1 and mode-2 plans for a multi-network fixture, the Tailscale health checks against fixtures for each failing state (override on, route unapproved, split route unanswered, shared-in node unnamed), the LAN-sharing four-step state machine with each step failing.
- **Certificates:** issuance against Pebble (Let's Encrypt's test ACME server) in Docker with a fake DNS-01 provider, then with the Route 53 driver against a recorded API; the export's atomic write, modes, owner and group; renewal timing through `t.scheduler.run`; a wrong IAM scope refused with the finding.
- **Operations (MCP and REST):** every contributed operation is called both ways with the same input and compared; the generated OpenAPI document validates and every path in it answers; a read-only key and a read-only connection are refused every write; a disabled operation is absent from both surfaces; one audit row per call with the person and the key or connection; a scrubbed answer never carries a secret; rate limits answer `429` with `Retry-After`; an operation naming a leaf outside its owner fails the activation.
- **Audits as tests:** `auditCoupling()` zero violations, `audit network`, `audit credentials`, the security-review gate strict in CI.

### Fuzzing

Coverage-guided fuzzing with Jazzer.js, in `digby-ext-wire` where the suites moved with the codec (§6.19), over `decode(buffer)`, `decodeAndReencode(buffer)`, the master-file parser and the TSIG verifier, seeded with the unit corpus and captures; a bounded run per PR, the long run nightly, the corpus committed under `tests/fuzz/corpus/`; crashes become regression tests. A second target is the whole engine behind an in-memory transport (`handle(datagram, from, to) → datagrams`), so compression, truncation and RRL are fuzzed together.

### Conformance

RFC checks as tests against Digby on ephemeral ports: 1034/1035, 2181, 2308, 4592, 6891 (unknown options ignored, version 1 → BADVERS), 7766/7828, 7873/9018, 8020, 8198, 8482, 8767, 8906, 9156, 9471, 1996/5936/1995/8945 (later, with `transfer`), 4033-4035/5155/6840/8624/9276, 8484, 7858, 9250 later. External checkers in CI containers: `dig`/`delv`, `kdig`, `drill`, `unbound-host`, `ldns-verify-zone`, `dnsviz` (offline), DNS-OARC's `ednscomp`, `zonemaster-cli` in lab mode. Interop against BIND 9 and Knot DNS in Docker as secondary and primary (later, with `transfer`).

### Load

`dnsperf` and `resperf` against a lab instance (authoritative: 10k qps with p99 under 2 ms is the pass mark; cached recursive; cold recursive against a local fake root), `flamethrower` for mixed UDP/TCP/DoT, RRL under a spoofed flood (slip ratio, no amplification above 1:1 for refused clients), cache fill, a snapshot swap under load with no lost answers.

### Interop with the homelab's parts

- **UniFi:** the Forward Domain rule forwards a domain and its subdomains and a reverse zone; a renewed lease carries the gateway and the search domain; mode-1 traffic reaches Digby from the gateway's addresses; the mode-2 plan hands out every node.
- **Tailscale:** the split route takes effect on iOS, Android, Windows and Linux clients; a tailnet client resolves `quack.shellback.net` through the split route to Digby; the health checks agree with `tailscale dns status`; Override stays off.
- **systemd-resolved, k3s CoreDNS, browsers and phones** as before: `resolvectl query`, DNSSEC `allow-downgrade`, the Global check; a pod's `nslookup` with Digby up and with Digby stopped (the gateway fallback); DoH templates and Android Private DNS against `dns.homelab.cldmv.net` in slice 3.
- **The compare tool** is the regression net after every deploy (previous slot vs new).

### End to end

A real-peer suite boots the whole app on ephemeral ports with the test key and drives the shell with Playwright for the zones editor, the networks map, the networks mode page and the admin to-do; the deploy harness (rummage#719) runs a fresh install, an update and a failed update with the DNS health probe.

## 13. Open questions and decisions

Numbers are stable across revisions. **Decided** items record the decision; items marked *default — not yet confirmed* carry the recommendation the plan assumes.

### Decided

- **Q1** Digby gets its own LAN address, `10.0.1.166`, added to the NetworkManager connection "Wired connection 1" with `nmcli` and reserved in UniFi (§10 step 3); adding addresses belongs to the `networks`/`unifi` extensions in the long run. **Q10** The 80/443 holder is **traefik** (`traefik:latest`, Portainer stack `traefik-proxy`, not k3s), publishing `0.0.0.0` and `[::]` on 80/443 and mounting `/srv/certs` and `/srv/traefik/dynamic`; its port bindings are narrowed to `10.0.1.165`, `100.64.178.0` and `::1` (Q27) in Portainer (§10 step 4). Technitium stops at cutover.
- **Q2** DHCP stays on UniFi.
- **Q3** Digby does not touch Route 53 in the first release; the wildcard stays hand-maintained. Later: `_acme-challenge` TXT writes for certificates (§11), then `homelab` subtree record management, then Route 53 DNSSEC signing of `cldmv.net`.
- **Q4** Full recursion from the root servers with DNSSEC validation in every mode from the first release; forwarders optional, never the default.
- **Q5** Technitium's blocking is not used; `blocking` is a future feature.
- **Q6** Multi-server is one generic feature: install on several servers and link them; what a node serves depends on what can reach it; a later slice.
- **Q7** `cldmv.net` is signed through Route 53 in the later Route 53 slice; Digby signs `homelab.cldmv.net` where it serves it directly.
- **Q8** The split route `homelab.cldmv.net → Digby`, and (Q8b) sharing chosen LAN networks with the tailnet as a Digby option: off by default, write scopes, audited, four steps with verification; shared-node users never get subnet routes.
- **Q9** No data migration from Technitium. Zones confirmed: only `homelab.cldmv.net` (wildcard) and the empty `quack.shellback.net`; only those are imported.
- **Q11** `localdomain` retired: UniFi's client names under `homelab.cldmv.net`, the DHCP search domain `homelab.cldmv.net`, a month of forwarding `localdomain` to the gateway.
- **Q12** `encrypted` folds into `server`; the machines driver is replaced by `networks-driver-unifi` and `networks-driver-tailscale` on `lib-unifi` and `lib-tailscale`, plugged into the new `networks` orchestrator (IP address management, per-network DNS settings, the mode switch, LAN sharing, network checks); `machines` owns no drivers.
- **Q13** Admin UI and MCP reachability is config: presets `lan-only`, `lan-tailnet` (the default), `anywhere`, plus custom networks; nothing hard-wired.
- **Q14** Raw query logs with client addresses: 7 days by default, admin-configurable; aggregates with their own configurable retention.
- **Q15** The Tailscale OAuth client starts read-only; writes are a separate opt-in; shared-in devices get names under the tailnet view by the same rules; an admin can rename or hide any machine.
- **Q16** One administrator with a password through rummage's password fill; per-person accounts later.
- **Q18** `CLDMV/lib-route53` → `@cldmv/lib-route53`, a standalone library like the other two; `digby-ext-public-driver-route53` is the driver built on it, plugged into `public`; both land in slice 3 with the ACME DNS-01 writes (§6.2, §9).
- **Q17** No interim hand-written unit; privileged ports, hardening and the related deploy needs go into rummage#717 (G3); Digby waits.
- **Q19** The UniFi API key (and a local account for the legacy fallback) is created when the integration slice is built; the Network application's version and the Forward Domain checks stay Phase 0 steps (§10 step 2).
- **Q21** No public record for `quack.shellback.net`: Quack on `llm-server` is reachable only through the shared tailnet; Digby answers it in the `tailnet` view with the address this tailnet sees, the split route stays, and the sharer's side resolves it inside their own tailnet (§4.15).
- Also decided: UniFi management of every network's DNS settings, search domain, fixed IPs and network list through the `networks` orchestrator's UniFi driver (writes opt-in, admin, audited); UniFi and Tailscale as drivers of `networks` with a vendor-neutral driver contract, so another router or VPN vendor plugs in the same way; the standalone `lib-unifi` and `lib-tailscale`; Tailscale health as admin to-do items with fix steps; `quack.shellback.net` as the worked example of naming a shared-in device.

- **Q20** `/srv/certs/homelab.key` and `homelab.fullchain.pem` are `root:repo` 0640 with ACL `user:glmtest:r--` (mask `r--`), last renewed 2026-09-26; readers are the traefik container (`/srv/certs` → `/certs`), Quack on `:18543` and glmtest's Quack instances. The takeover writes in place to keep owner, mode and ACL, adds an ACL entry for the digby user, and reloads traefik after each renewal (§11).
- **Q22** The admin UI port: `8443` on Digby's addresses in the first release; once the proxy owns 443 (slice 3b) the admin UI and DoH are routes on it (`digby.homelab.cldmv.net`, `/dns-query`), so nothing else binds 443.
- **Q25** Digby replaces traefik with its own reverse proxy, `digby-ext-proxy` (§6.18), as its own slice (3b) after the certificate takeover; traefik keeps running until the proxy reaches parity and is then removed (§10 Phase 6). One allow list per source, held in views, drives both DNS filtering and the proxy (#47, #48). Tracked in #49.

- **Q26** The relay VPS (an nginx vhost plus certbot per org, fronting `ics.cldmv.net`) becomes Digby's front door too (**decided**): it is a later feature, but small enough to do now, and the sizing below settles it into slice 3b's second half. Sized (§6.18): 01 fronting the relay's names is not the shape (01 is not publicly addressed; the relay exists to be the public front door), so the coverage is the same proxy extension deployed as its own rummage instance on the relay — ACME DNS-01 through the provider driver instead of certbot, routes and allow lists local to that instance, no new routing code. Its own acceptance: every nginx vhost answers identically through the relay's proxy, including the `/v1/vine` WebSocket upgrade and the long-lived SSE keepalive on `/v1/events` the nginx forwards today; ACME renews the relay's names; certbot retired; it trails within the slice since it gates nothing on traefik's removal. It rides under #49; no separate issue.
- **Q27** IPv6 (**decided**): the proxy and the DNS listeners bind IPv6 on 80/443/53 alongside IPv4 — on the IPv6 addresses 01 actually has, never on `[::]`. On 01 that is loopback `::1` only: the host binds no tailnet IPv6 address, because it doesn't carry one — `tailscale ip` reports an `fd7a:115c:a1e0::/48` address, but it is assigned to no interface (`tailscale0` holds only the IPv4 /32 and a link-local) and the route table has no entry for it, so a bind to it would fail with `EADDRNOTAVAIL`; only the MagicDNS resolver address `fd7a:115c:a1e0::53` appears, which is not 01's own. 01 has no global IPv6, so nothing is served on a public v6 address; if the box gains an address, the address lists grow. The transition is per-address on both sides: Phase 0 step 4 re-binds traefik from `0.0.0.0`/`[::]` to explicit addresses — `10.0.1.165`, `100.64.178.0` and `::1` — so traefik keeps serving v6 clients while the wildcard binds are gone; Technitium keeps `[::]:53` until Phase 3, so Digby's `:53` v6 listeners wait under `retryBind` with the v4 ones and bind at cutover; and the proxy takes `::1` on 80/443 in Phase 6 (§10 step 26), once the container stops. The test suites bind and exercise loopback `::1`.
- **Q28** Termination only (**decided**): the proxy terminates TLS, checks the TLS server name and the Host header against the allow list, and talks plain HTTP to the backend. SNI passthrough and re-encryption are a later feature, tracked in CLDMV/digby#50 — nothing behind traefik today needs it, and in passthrough mode the allow list can match SNI only (no Host header exists).

### Open: facts to confirm

- Whether Route 53 hosts the zones the relay's per-org names live in (the per-org domains certbot fronts on the relay VPS, §6.18, §11). `ics.cldmv.net` itself sits inside `cldmv.net`, which Route 53 already hosts (Q3 plans that zone's DNSSEC signing there), so it is not part of the question; the §6.18 assumption that the relay's ACME DNS-01 writes are Route 53 challenge writes (#46's per-name placement) depends on the per-org zones. If they sit with another provider, the relay's driver is that provider's instead. Until it is confirmed, the relay slice also needs the per-org name list off the relay's certbot configuration.

### Defaults — not yet confirmed

- **Q23** The first compare runs with the resolver in forwarder mode mirroring Technitium's forwarders, then switches to recursion, so differences are Digby's and not the upstream's. *Default: yes, if Technitium's forwarders are known from its UI; otherwise compare in recursive mode and accept upstream-caused TTL and ordering differences.*
- **Q24** Reverse zones are new (Technitium has none): PTRs for every address the `networks` extension knows, generated from `machines` in slice 2; hand-entered for the known hosts in slice 1. *Default: yes.*

## 14. Appendix: probe results

Collected 2026-11-12, read-only, from host 01.

```text
/etc/resolv.conf            nameserver 10.0.1.165 ; search localdomain tail935f4f.ts.net (resolved, uplink mode)
resolvectl eno1             DNS 10.0.1.165, domain localdomain, +DefaultRoute
resolvectl tailscale0       DNS 100.100.100.100 fd7a:115c:a1e0::53 ; domains tail935f4f.ts.net ~100.64-127.in-addr.arpa ~…fd7a:115c:a1e0 ip6.arpa
ip -br addr                 eno1 10.0.1.165/23 ; default via 10.0.0.1 (dhcp) ; 10.42.0.0/24 cni0 ; docker bridges
k3s                         /etc/rancher/k3s/resolv.conf = nameserver 10.0.1.165 ; config resolv-conf pinned
ss :53                      0.0.0.0:53 and [::]:53, udp+tcp (Technitium) ; :5380 http (Technitium UI) ; no :853
ps                          traefik (traefik:latest container, Portainer stack traefik-proxy, mounts /srv/certs + /srv/traefik/dynamic) ; nginx (root master + workers) ; tailscale serve: no config
eno1                        NetworkManager "Wired connection 1" (DHCP) ; 10.0.1.166 answers no ARP or ping
:443 / :80                  HTTP/2, Go plain-text 404 ; cert CN=homelab.cldmv.net (Let's Encrypt) SANs *.homelab.cldmv.net *.01.homelab.cldmv.net *.scopra.homelab.cldmv.net homelab.cldmv.net → traefik
Technitium process          /usr/bin/dotnet /opt/technitium/dns/DnsServerApp.dll /etc/dns ; cgroup docker-90168b08…scope ; not in the default Docker daemon
Technitium AXFR             refused
Technitium zones (aa SOA)   homelab.cldmv.net (apex A 10.0.1.165, NS homelab.cldmv.net., wildcard → 10.0.1.165) ; quack.shellback.net (empty: SOA, no A)
Technitium not authoritative cldmv.net shellback.net localdomain 0.0.10/1.0.10/10/100 in-addr.arpa tail935f4f.ts.net ts.net lan home.arpa internal local (REFUSED)
Technitium resolver         recursive, ad flag on cloudflare.com, SERVFAIL dnssec-failed.org, EDNS udp 1232
UniFi gateway 10.0.0.1      UDM Pro SE (UniFi OS /api/system: hardware UDMPROSE, deviceState updateAvailable) ; Network app /proxy/network/status → 401 ; cert CN=unifi.local
dig NS cldmv.net            ns-1458.awsdns-54.org ns-1873.awsdns-42.co.uk ns-321.awsdns-40.com ns-647.awsdns-16.net (Route 53) ; no DS ; CAA awstrust.com, letsencrypt.org
dig @1.1.1.1 *.homelab      100.64.178.0 ; apex homelab.cldmv.net 52.36.212.193 ; NS homelab none ; ics.cldmv.net 15.204.120.140 everywhere
quack.shellback.net         split route → 100.64.178.0 ; no A from 1.1.1.1 ; NODATA from Technitium ; NS shellback.net = Route 53
tailscale status            01-homelab-cldmv 100.64.178.0 ; ics-laptop ; ipad172 ; iphone-15-pro ; stratax-proxy 100.120.122.31 ; llm-server 100.94.135.85 (shared from timeless.wines@)
tailscale dns status        MagicDNS on, suffix tail935f4f.ts.net ; no tailnet resolvers (override off) ; split: quack.shellback.net→100.64.178.0, ts.net→199.247.155.53
acme.sh                     /srv/acme/acme.sh ; certs /srv/certs/homelab.{key,fullchain.pem} root:repo 0640, ACL user:glmtest:r-- mask r--, renewed 2026-09-26 ; _acme-challenge TXT currently empty
/srv/certs readers          traefik container (/srv/certs → /certs) ; Quack :18543 (rummage config) ; glmtest's Quack instances (ACL)
unifi-cli legacy API        api/s/{site}/rest/networkconf ; rest/user/{id} (fixed_ip) ; v2/api/site/{site}/client/{id} ; login, device detect, auto-ip task
rummage                     dev @ d1f92d21, 0.1.460 ; deploy issues #717/#719–#728/#748 read ; #719–#722 landed, #723/#724 next, #725–#728 open
```
