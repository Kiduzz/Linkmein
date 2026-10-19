# Host Linkmein for free on Oracle Cloud

Oracle Cloud's **Always Free** tier includes an always-on ARM server with up to 4 CPU cores and 24 GB of memory, at no cost. This is plenty for Linkmein. This guide takes about 30–45 minutes the first time.

What you end up with:

- Linkmein at `https://your-domain`, with a free HTTPS certificate that renews itself
- Scheduled posts that publish around the clock, whether your own computer is on or not
- Your data in one folder on the server, easy to back up

## 1. Create an Oracle Cloud account

1. Sign up at https://www.oracle.com/cloud/free/.
2. Oracle asks for a card to verify your identity. Always Free resources aren't charged.
3. **Choose your home region carefully.** You can't change it later, and the free ARM servers are only available there. Pick one near you. If you later get "out of capacity" errors, it's this region that's busy.

## 2. Create the server

In the Oracle Cloud console, open **☰ → Compute → Instances → Create instance**.

1. **Name:** `linkmein`.
2. **Image and shape → Edit:**
   - **Image:** *Canonical Ubuntu 24.04*.
   - **Shape:** *Ampere → VM.Standard.A1.Flex*, with **2 OCPUs** and **12 GB memory**. It should show an "Always Free-eligible" label.
3. **Networking:** keep *Create new virtual cloud network* and *Create new public subnet*, and make sure **Assign a public IPv4 address** is on.
4. **SSH keys:** choose *Generate a key pair for me* and **download the private key**. You need it to log in.
5. Click **Create**. After a minute or two, the instance page shows its **Public IP address**. Copy it.

> **"Out of capacity for shape VM.Standard.A1.Flex"?** Free ARM capacity is in demand. Try another *Availability domain* in step 2, try 1 OCPU / 6 GB, or try again later. It usually works within a day.

## 3. Open the web ports in Oracle's firewall

Oracle blocks everything except SSH by default.

1. On the instance page, click the **Subnet** link, then the **Default Security List**.
2. Click **Add Ingress Rules** and add:
   - Source CIDR `0.0.0.0/0`, IP protocol **TCP**, destination port range **`80,443`**.
3. Save.

## 4. Log in and open the ports on the server

On your computer, using the key you downloaded:

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@YOUR_PUBLIC_IP
```

Oracle's Ubuntu images also have their own firewall. Open ports 80 and 443 there too:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 5. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

Log back in with the same `ssh` command so the Docker permission takes effect.

## 6. Pick your address

You need a name that points at your server's IP address. Pick one:

- **You have a domain on Cloudflare:** in Cloudflare, go to **DNS → Add record**. Use type **A**, name `linkmein`, IPv4 address = your server's public IP, and **Proxy status: DNS only (grey cloud)**. Your address is `linkmein.yourdomain.com`.
- **You don't have a domain:** use [sslip.io](https://sslip.io), which is free with no sign-up. Write your IP with dashes followed by `.sslip.io`. For example, if your IP is `203.0.113.10`, your address is `203-0-113-10.sslip.io`.

The rest of this guide calls it `YOUR_DOMAIN`.

## 7. Get Linkmein and configure it

On the server:

```bash
git clone https://github.com/kiduzz/linkmein.git
cd linkmein
cp .env.example .env
nano .env
```

Set these lines and leave the rest as they are:

```
DOMAIN=YOUR_DOMAIN
BASE_URL=https://YOUR_DOMAIN
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
LINKEDIN_DRY_RUN=false
ALLOW_DEV_LOGIN=false
```

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

In your LinkedIn developer app (see the README), on the **Auth** tab, add this **Authorized redirect URL**:

```
https://YOUR_DOMAIN/auth/linkedin/callback
```

## 8. Start it

```bash
docker compose --profile https up -d --build
```

The first build takes a few minutes. Then open `https://YOUR_DOMAIN`, sign in with LinkedIn, and add your Claude API key under **Settings**.

To watch the logs:

```bash
docker compose logs -f
```

Linkmein and Caddy restart automatically if they crash or the server reboots.

## Updating

```bash
cd ~/linkmein
git pull
docker compose --profile https up -d --build
```

## Backups

Everything lives in `~/linkmein/data`: the database, your uploads, and `app-secret.key`. To make a backup on the server:

```bash
cd ~/linkmein && tar czf ~/linkmein-backup-$(date +%F).tar.gz data
```

Then copy it to your own computer:

```bash
scp -i ~/Downloads/ssh-key-*.key ubuntu@YOUR_PUBLIC_IP:~/linkmein-backup-*.tar.gz .
```

Keep backups private. `app-secret.key` decrypts the stored API keys and LinkedIn tokens.

## Things to know

- **Idle servers can be reclaimed.** Oracle's policy says it may reclaim Always Free instances that stay mostly idle (low CPU, network and memory use) for 7 days. Linkmein is idle most of the time. To avoid this, upgrade the account to *Pay As You Go* under **Billing → Upgrade and Manage Payment**. Always Free resources stay free after upgrading, and you're only charged if you create something outside the free limits. If you upgrade, set a budget alert of $1 under **Billing → Budgets** so any charge is flagged straight away.
- **Stick to Always Free-labelled resources.** The free tier covers up to 4 OCPUs and 24 GB of memory of A1 compute, and 200 GB of block storage in total.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The site doesn't load / Caddy logs `failed to obtain certificate` | Ports 80 and 443 must be open in **both** places (step 3 and step 4). Check that `YOUR_DOMAIN` points at the server's IP. On Cloudflare, the record must be **DNS only** (grey cloud). |
| LinkedIn says `redirect_uri does not match` | `BASE_URL` in `.env` and the redirect URL in your LinkedIn app must match exactly, including `https://`. Run `docker compose --profile https up -d` again after editing `.env`. |
| You changed `.env` but nothing changed | Run `docker compose --profile https up -d` to restart with the new settings. |
| Voice notes show "Transcription failed" | Transcription runs in your browser and downloads the speech model the first time, so check your own internet connection, then click **Transcribe again** in the Library. You can always type the transcript yourself. |
