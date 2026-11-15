# ADR 0065 — Hosts tell devices where they are, on every link

**Date:** 2026-11-15
**Status:** Accepted
**Relates to:** [ADR-0057](0057-remote-access.md), [ADR-0063](0063-no-handover-of-typing-control.md)

## Context

A device kept a host's addresses and relay only from the pairing code, and never updated
them. Testing on the Android emulator against the Windows PC showed what that breaks: the PC
was paired before its relay was on, so with the direct path blocked the phone had no relay to
try and stayed "Reconnecting". The same gap loses a host whose address changes (a new DHCP
lease, another network) until every device pairs again.

## Decision

- **The host says where it is on every link.** Right after the welcome, the host sends
  `Reachable { addrs, relay_url }` (an appended message tag): what a pairing code made now
  would say, computed by the same `kriyon_remote_link::invite::reachable`.
- **The device dials what the host said last.** The device runtime keeps it as the address
  it dials from the next try on, and each app saves it to its paired-host record (the
  desktop's `paired_hosts`, the phone's store), so a restart dials it too.
- **One account, one relay.** A device signed in to our relay dials a host whose relay it
  doesn't know through its own relay: our relay only joins the devices of one account, so a
  host on that account is reachable there.
- **Best effort.** A host the device can't reach at all can't tell it anything; the relay
  (when on) is what covers a host whose direct address changed while no link was up.

## Consequences

- Turning the relay on, or a host's address changing, reaches every device at its next link,
  without pairing again.
- A device with no relay and no link to a host whose LAN address changed still has to pair
  again; local discovery (mDNS) would close that gap and is not done.
