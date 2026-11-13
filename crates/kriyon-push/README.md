# kriyon-push

Kriyon's push sender: the small server that shows "A session needs you" on
a phone when the Kriyon app on it is closed. It is open source so anyone can
check what it does, and run their own.

## What it does, and doesn't

The phone gives each of your computers a copy of its push token, sealed so
only this sender can open it (HPKE, spec section 10). When a session needs
you and no device is looking, the computer asks the sender to wake the phone
and signs the request with its own key.

For each request the sender:

1. checks the computer's signature, that the time is within five minutes of
   its own, and that it hasn't seen the request id in the last ten minutes;
2. opens the token in memory and checks it was sealed for that computer and
   hasn't expired;
3. holds each computer and each phone to one alert a minute and thirty a
   day;
4. sends one alert, "A session needs you", through Apple's or Google's push
   service, and forgets the token.

It stores nothing. The request ids and the counts for the limits are kept in
memory, for ten minutes and a day, and go when it restarts. It never reads
the address a request comes from, and its log holds only what happened ("wake
sent", "wake refused (too_many)"), never a token, an id or an address; a test
fails if one appears.

The alert never names a session. The details come over the encrypted link
when the app opens.

## Endpoints

- `GET /v1/key`: `{ "key_id": 1, "public_key": "<hex>" }`, the key phones
  seal their tokens to.
- `POST /v1/wake`: `{ key_id, sealed, at, request_id, host_id, signature }`,
  bytes in hex. `202` when sent; otherwise an error word with `400`, `401`,
  `404` (the push service dropped the token), `409` (seen before), `410`
  (expired), `422`, `429` (limit), `501` or `502`.

## Running it

```sh
cargo run -p kriyon-push -- new-key > push.secret   # once
docker build -f crates/kriyon-push/Dockerfile -t kriyon-push .
docker run --env-file push.env -v "$PWD/secrets:/secrets:ro" -p 8080:8080 kriyon-push
```

Settings come from the environment (`push.env.example` lists them), and
secrets from the files it names. It speaks plain HTTP: put a TLS proxy in
front, with its access log off.
