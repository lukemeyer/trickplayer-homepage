/**
 * Interactive Web-based Trickplayer based on the G2 Preview Player.
 * Supports built-in Tears of Steel demo as well as connecting directly to Plex and Jellyfin.
 * All authentication tokens and media stay strictly in your browser.
 */

import { parseTimelineIndex, extractFrameBlob } from "./bif.js";
import { parseSrt, findActiveCue, cleanSubText } from "./subtitles.js";
import { renderFrameToCanvas } from "./dither.js";

const PLEX_CLIENT_ID = "trickplayer-web-preview";
const JELLYFIN_CLIENT = "TrickplayerWeb";

export class TrickplayerWeb {
  constructor(options = {}) {
    this.container = options.container || document.getElementById("trickplayer-container");
    this.bifBuffer = null;
    this.timeline = null;
    this.subtitles = [];
    this.scenes = [];
    this.isPlaying = false;
    this.currentTimeMs = 0;
    this.durationMs = 0;
    this.displayMode = "g2"; // "g2" | "pebble" | "wearos"
    this.pictureOpts = {
      contrast: 0,
      brightness: 0,
      gamma: 1.0,
      dither: "floyd-steinberg",
    };

    // Frame fetcher for remote sources (Plex / Jellyfin)
    this.customFrameFetcher = null;

    this.clockTimer = null;
    this.lastClockTick = 0;
    this.frameCache = new Map(); // frameIndex -> Image
    this.activeFrameIndex = -1;

    // DOM Elements
    this.canvas = document.getElementById("player-canvas");
    this.subtitleEl = document.getElementById("player-subtitle");
    this.playBtn = document.getElementById("btn-play");
    this.prevBtn = document.getElementById("btn-prev-scene");
    this.nextBtn = document.getElementById("btn-next-scene");
    this.slider = document.getElementById("timeline-slider");
    this.timeDisplay = document.getElementById("time-display");
    this.deviceFrame = document.getElementById("player-device-frame");

    this.initEvents();
    this.initServerConnections();
  }

  // -------------------------------------------------------------------------
  // Demo Content (Tears of Steel)
  // -------------------------------------------------------------------------

  async loadDemo() {
    try {
      this.setStatus("Loading demo…");
      const [bifRes, srtRes] = await Promise.all([
        fetch("assets/demo/tears-of-steel.bif"),
        fetch("assets/demo/tears-of-steel.srt"),
      ]);

      if (!bifRes.ok || !srtRes.ok) {
        throw new Error("Could not fetch demo files");
      }

      const bifBuf = await bifRes.arrayBuffer();
      const srtText = await srtRes.text();

      this.customFrameFetcher = null;
      await this.loadData(bifBuf, srtText, "Demo");
      this.setStatus("");
    } catch (err) {
      console.error("Failed to load demo:", err);
      this.setStatus(`Demo error: ${err.message}`);
    }
  }

  async loadData(bifBuffer, srtText, title = "Media") {
    this.pause();
    this.bifBuffer = bifBuffer;
    this.timeline = parseTimelineIndex(bifBuffer);
    this.subtitles = parseSrt(srtText);
    this.durationMs = this.timeline.durationMs;
    this.currentTimeMs = 22000; // Start at 22s for instant dialogue playback
    this.frameCache.clear();

    if (this.slider) {
      this.slider.min = 0;
      this.slider.max = this.durationMs;
      this.slider.value = this.currentTimeMs;
    }

    this.buildScenes();
    await this.updateFrameAt(this.currentTimeMs);
    this.updateUI();
  }

  buildScenes() {
    if (!this.timeline || !this.timeline.frames.length) {
      this.scenes = [];
      return;
    }

    const scenes = [];
    const frames = this.timeline.frames;

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const nextF = frames[i + 1];
      const startMs = f.tsMs;
      const endMs = nextF ? nextF.tsMs : startMs + 2000;

      // In Trickplayer: A cue belongs to the scene it starts in
      const cues = this.subtitles.filter(
        (c) => c.startMs >= startMs && c.startMs < endMs
      );

      scenes.push({
        index: i,
        frameIndex: i,
        startMs,
        endMs,
        cues,
        text: cues.map((c) => c.text).join(" "),
      });
    }

    this.scenes = scenes;
  }

  // -------------------------------------------------------------------------
  // Event Handlers & Picture Controls
  // -------------------------------------------------------------------------

  initEvents() {
    if (this.playBtn) {
      this.playBtn.addEventListener("click", () => this.togglePlay());
    }

    if (this.prevBtn) {
      this.prevBtn.addEventListener("click", () => this.seekToPrevScene());
    }

    if (this.nextBtn) {
      this.nextBtn.addEventListener("click", () => this.seekToNextScene());
    }

    if (this.slider) {
      this.slider.addEventListener("input", (e) => {
        this.currentTimeMs = Number(e.target.value);
        this.updateFrameAt(this.currentTimeMs);
        this.updateUI();
      });
    }

    // Display mode buttons
    document.querySelectorAll("[data-player-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-player-mode]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.setDisplayMode(btn.dataset.playerMode);
      });
    });

    this.updateClockDisplays();
    setInterval(() => this.updateClockDisplays(), 10000);
  }

  updateClockDisplays() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const str = `${hh}:${mm}`;
    document.querySelectorAll(".live-device-clock").forEach((el) => {
      el.textContent = str;
    });
  }

  setDisplayMode(mode) {
    this.displayMode = mode;
    if (this.deviceFrame) {
      this.deviceFrame.className = `device-frame frame-${mode}`;
    }

    if (this.canvas) {
      // Measured device screen layout dimensions from respective platform repos:
      if (mode === "g2") {
        // Even Realities G2: GLASSES_IMAGE_WIDTH = 256, GLASSES_IMAGE_HEIGHT = 128
        this.canvas.width = 256;
        this.canvas.height = 128;
      } else if (mode === "pebble") {
        // Pebble Time 2 (Emery): FW = 160, FH = 90 (centered at x=20 on 200x228 panel)
        this.canvas.width = 160;
        this.canvas.height = 90;
      } else if (mode === "wearos") {
        // Wear OS (WFF): 341x192 at y=54..246 on 450x450 circular canvas
        this.canvas.width = 341;
        this.canvas.height = 192;
      }
    }

    this.updateClockDisplays();
    this.refreshCurrentFrame();
  }

  async getFrameImage(frameIndex) {
    if (this.frameCache.has(frameIndex)) {
      return this.frameCache.get(frameIndex);
    }

    let url = null;
    let cleanupBlob = false;

    if (this.customFrameFetcher) {
      // Custom server provider (Plex / Jellyfin)
      url = await this.customFrameFetcher(frameIndex);
    } else if (this.bifBuffer) {
      // Local BIF buffer
      const frame = this.timeline?.frames[frameIndex];
      if (!frame) return null;
      const blob = extractFrameBlob(this.bifBuffer, frame);
      url = URL.createObjectURL(blob);
      cleanupBlob = true;
    }

    if (!url) return null;

    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (cleanupBlob) URL.revokeObjectURL(url);
        this.frameCache.set(frameIndex, img);
        if (this.frameCache.size > 30) {
          const firstKey = this.frameCache.keys().next().value;
          this.frameCache.delete(firstKey);
        }
        resolve(img);
      };
      img.onerror = () => {
        if (cleanupBlob) URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  async updateFrameAt(tsMs) {
    if (!this.timeline || !this.timeline.frames.length) return;

    let idx = this.timeline.frames.findIndex(
      (f, i) => f.tsMs <= tsMs && (this.timeline.frames[i + 1]?.tsMs > tsMs || !this.timeline.frames[i + 1])
    );
    if (idx < 0) idx = 0;

    this.activeFrameIndex = idx;
    const img = await this.getFrameImage(idx);
    if (img && this.canvas) {
      renderFrameToCanvas(img, this.canvas, this.displayMode, this.pictureOpts);
    }

    const activeCue = findActiveCue(this.subtitles, tsMs);
    if (this.subtitleEl) {
      if (activeCue) {
        this.subtitleEl.innerHTML = cleanSubText(activeCue.text).replace(/\n/g, "<br>");
        this.subtitleEl.classList.remove("empty");
      } else {
        this.subtitleEl.innerHTML = "";
        this.subtitleEl.classList.add("empty");
      }
    }
  }

  refreshCurrentFrame() {
    if (this.activeFrameIndex >= 0) {
      this.getFrameImage(this.activeFrameIndex).then((img) => {
        if (img && this.canvas) {
          renderFrameToCanvas(img, this.canvas, this.displayMode, this.pictureOpts);
        }
      });
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  play() {
    if (this.isPlaying || !this.timeline) return;
    this.isPlaying = true;
    if (this.playBtn) this.playBtn.textContent = "Pause";
    this.lastClockTick = performance.now();

    this.clockTimer = setInterval(() => {
      if (!this.isPlaying) return;
      const now = performance.now();
      const dt = now - this.lastClockTick;
      this.lastClockTick = now;

      this.currentTimeMs += dt;
      if (this.currentTimeMs >= this.durationMs) {
        this.currentTimeMs = 0;
        this.pause();
      }

      this.updateFrameAt(this.currentTimeMs);
      this.updateUI();
    }, 100);
  }

  pause() {
    this.isPlaying = false;
    if (this.playBtn) this.playBtn.textContent = "Play";
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  seekToPrevScene() {
    if (!this.scenes.length) return;
    const prev = [...this.scenes]
      .reverse()
      .find((s) => s.startMs < this.currentTimeMs - 1500 && s.text.length > 0);
    if (prev) {
      this.currentTimeMs = prev.startMs;
    } else {
      this.currentTimeMs = Math.max(0, this.currentTimeMs - 5000);
    }
    this.updateFrameAt(this.currentTimeMs);
    this.updateUI();
  }

  seekToNextScene() {
    if (!this.scenes.length) return;
    const next = this.scenes.find((s) => s.startMs > this.currentTimeMs + 500 && s.text.length > 0);
    if (next) {
      this.currentTimeMs = next.startMs;
    } else {
      this.currentTimeMs = Math.min(this.durationMs, this.currentTimeMs + 5000);
    }
    this.updateFrameAt(this.currentTimeMs);
    this.updateUI();
  }

  updateUI() {
    if (this.slider) {
      this.slider.value = this.currentTimeMs;
    }
    if (this.timeDisplay) {
      this.timeDisplay.textContent = `${this.formatTime(this.currentTimeMs)} / ${this.formatTime(this.durationMs)}`;
    }
  }

  formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  setStatus(msg) {
    const el = document.getElementById("player-status");
    if (el) el.innerHTML = msg;
  }

  // -------------------------------------------------------------------------
  // Server Connections (Plex & Jellyfin)
  // -------------------------------------------------------------------------

  initServerConnections() {
    // Tab buttons
    const tabs = document.querySelectorAll(".source-tab-btn");
    const panels = document.querySelectorAll(".source-panel");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.add("hidden"));

        tab.classList.add("active");
        const panelId = `panel-${tab.dataset.source}`;
        const targetPanel = document.getElementById(panelId);
        if (targetPanel) targetPanel.classList.remove("hidden");

        if (tab.dataset.source === "demo") {
          this.loadDemo();
        }
      });
    });

    // Plex Auth & Connection
    this.initPlexControls();

    // Jellyfin Auth & Connection
    this.initJellyfinControls();
  }

  initPlexControls() {
    const plexPinBtn = document.getElementById("btn-plex-pin");
    const plexDirectBtn = document.getElementById("btn-plex-direct");
    const plexStatus = document.getElementById("plex-auth-status");
    const plexPinDisplay = document.getElementById("plex-pin-display");

    let pollInterval = null;

    if (plexPinBtn) {
      plexPinBtn.addEventListener("click", async () => {
        try {
          if (pollInterval) clearInterval(pollInterval);
          plexStatus.textContent = "Minting PIN…";
          plexPinBtn.disabled = true;

          const res = await fetch("https://plex.tv/api/v2/pins", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-Plex-Product": "Trickplayer",
              "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
            },
            body: JSON.stringify({ strong: false }),
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const pinData = await res.json();

          plexPinDisplay.textContent = pinData.code;
          plexPinDisplay.style.display = "inline-block";
          plexStatus.innerHTML = `Go to <a href="https://plex.tv/link" target="_blank" rel="noopener" style="text-decoration:underline;color:var(--accent-wearos);">plex.tv/link</a> and enter code <strong>${pinData.code}</strong>.`;

          // Poll for authorization
          pollInterval = setInterval(async () => {
            try {
              const pollRes = await fetch(`https://plex.tv/api/v2/pins/${pinData.id}`, {
                headers: {
                  Accept: "application/json",
                  "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
                },
              });
              if (!pollRes.ok) return;
              const pollData = await pollRes.json();
              if (pollData.authToken) {
                clearInterval(pollInterval);
                plexStatus.textContent = "Authorized! Discovering servers…";
                await this.onPlexAuthorized(pollData.authToken);
              }
            } catch (err) {
              console.error("Plex poll error:", err);
            }
          }, 2000);
        } catch (err) {
          plexStatus.textContent = `Could not get PIN: ${err.message}`;
          plexPinBtn.disabled = false;
        }
      });
    }

    if (plexDirectBtn) {
      plexDirectBtn.addEventListener("click", async () => {
        const url = document.getElementById("plex-server-url")?.value.trim();
        const token = document.getElementById("plex-token")?.value.trim();
        if (!url || !token) {
          plexStatus.textContent = "Please provide both Server URL and X-Plex-Token.";
          return;
        }
        plexStatus.textContent = "Connecting to Plex server…";
        await this.loadPlexItems(url.replace(/\/$/, ""), token);
      });
    }
  }

  async onPlexAuthorized(authToken) {
    const plexStatus = document.getElementById("plex-auth-status");
    const serverSelect = document.getElementById("plex-server-select");
    const serverSelectGroup = document.getElementById("plex-server-select-group");

    try {
      const res = await fetch("https://plex.tv/api/v2/resources?includeHttps=1", {
        headers: {
          Accept: "application/json",
          "X-Plex-Token": authToken,
          "X-Plex-Client-Identifier": PLEX_CLIENT_ID,
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const resources = await res.json();
      const servers = resources.filter((r) => r.provides && r.provides.includes("server"));

      if (!servers.length) {
        plexStatus.textContent = "No Plex servers found under this account.";
        return;
      }

      serverSelect.innerHTML = '<option value="">Select a server…</option>';
      servers.forEach((s, idx) => {
        const opt = document.createElement("option");
        opt.value = idx;
        opt.textContent = `${s.name} (${s.connections.length} connection${s.connections.length === 1 ? "" : "s"})`;
        serverSelect.appendChild(opt);
      });

      serverSelectGroup.style.display = "block";
      plexStatus.textContent = `Found ${servers.length} server(s). Select one to browse:`;

      serverSelect.onchange = async () => {
        const selected = servers[serverSelect.value];
        if (!selected) return;
        // Prefer local connection or first reachable connection
        const conn = selected.connections.find((c) => c.local) || selected.connections[0];
        const serverUrl = conn.uri;
        const serverToken = selected.accessToken || authToken;
        plexStatus.textContent = `Connecting to ${selected.name} (${serverUrl})…`;
        await this.loadPlexItems(serverUrl, serverToken);
      };
    } catch (err) {
      plexStatus.textContent = `Failed to list servers: ${err.message}`;
    }
  }

  async loadPlexItems(serverUrl, token) {
    const plexStatus = document.getElementById("plex-auth-status");
    const itemSelect = document.getElementById("plex-item-select");
    const itemSelectGroup = document.getElementById("plex-item-select-group");

    try {
      // Fetch On Deck or recent items
      const res = await fetch(`${serverUrl}/library/onDeck`, {
        headers: { Accept: "application/json", "X-Plex-Token": token },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const metadata = data.MediaContainer?.Metadata || [];

      if (!metadata.length) {
        plexStatus.textContent = "Connected! No 'On Deck' items found. (Ensure items have trickplay and external subtitles generated).";
        return;
      }

      itemSelect.innerHTML = '<option value="">Select an episode to play…</option>';
      metadata.forEach((item) => {
        const opt = document.createElement("option");
        opt.value = item.ratingKey;
        opt.textContent = `${item.grandparentTitle ? `${item.grandparentTitle} - ` : ""}${item.title}`;
        itemSelect.appendChild(opt);
      });

      itemSelectGroup.style.display = "block";
      plexStatus.textContent = "Server connected! Select an episode with trickplay:";

      itemSelect.onchange = async () => {
        const key = itemSelect.value;
        if (!key) return;
        const chosen = metadata.find((m) => String(m.ratingKey) === String(key));
        if (chosen) {
          await this.loadPlexMedia(serverUrl, token, chosen);
        }
      };
    } catch (err) {
      plexStatus.textContent = `Connection error: ${err.message}. (If in browser, verify CORS headers or mixed content permissions).`;
    }
  }

  async loadPlexMedia(serverUrl, token, mediaItem) {
    const plexStatus = document.getElementById("plex-auth-status");
    try {
      plexStatus.textContent = `Loading trickplay and subtitles for "${mediaItem.title}"…`;
      const part = mediaItem.Media?.[0]?.Part?.[0];
      if (!part) throw new Error("No media part found");

      // BIF SD index endpoint in Plex
      const indexUrl = `${serverUrl}/library/parts/${part.id}/indexes/sd`;
      const subStream = part.Stream?.find((s) => s.streamType === 3 && s.key);

      // Fetch BIF header + index table
      const bifRes = await fetch(indexUrl, {
        headers: { "X-Plex-Token": token },
      });
      if (!bifRes.ok) throw new Error(`Trickplay BIF not found (HTTP ${bifRes.status}). Generate video preview thumbnails in Plex library settings.`);

      const bifBuf = await bifRes.arrayBuffer();
      let srtText = "";

      if (subStream && subStream.key) {
        const subRes = await fetch(`${serverUrl}${subStream.key}`, {
          headers: { "X-Plex-Token": token },
        });
        if (subRes.ok) srtText = await subRes.text();
      }

      this.customFrameFetcher = null;
      await this.loadData(bifBuf, srtText, mediaItem.title);
      this.setStatus(`Playing from Plex: ${mediaItem.title}`);
      plexStatus.textContent = `Ready! Playing "${mediaItem.title}".`;
    } catch (err) {
      plexStatus.textContent = `Error: ${err.message}`;
    }
  }

  // Jellyfin Controls
  initJellyfinControls() {
    const jfConnectBtn = document.getElementById("btn-jf-connect");
    const jfStatus = document.getElementById("jf-status");

    if (jfConnectBtn) {
      jfConnectBtn.addEventListener("click", async () => {
        const url = document.getElementById("jf-server-url")?.value.trim();
        const token = document.getElementById("jf-token")?.value.trim();

        if (!url || !token) {
          jfStatus.textContent = "Please provide your Jellyfin server address and API token.";
          return;
        }

        const base = url.replace(/\/$/, "");
        jfStatus.textContent = "Connecting to Jellyfin…";

        try {
          const res = await fetch(`${base}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Limit=20`, {
            headers: {
              Authorization: `MediaBrowser Token="${token}", Client="${JELLYFIN_CLIENT}"`,
              Accept: "application/json",
            },
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const items = data.Items || [];

          if (!items.length) {
            jfStatus.textContent = "Connected! No episodes/movies found.";
            return;
          }

          const selectGroup = document.getElementById("jf-item-select-group");
          const selectEl = document.getElementById("jf-item-select");
          selectEl.innerHTML = '<option value="">Select an item…</option>';

          items.forEach((item) => {
            const opt = document.createElement("option");
            opt.value = item.Id;
            opt.textContent = `${item.SeriesName ? `${item.SeriesName} - ` : ""}${item.Name}`;
            selectEl.appendChild(opt);
          });

          selectGroup.style.display = "block";
          jfStatus.textContent = `Connected! Found ${items.length} items.`;

          selectEl.onchange = async () => {
            const itemId = selectEl.value;
            if (!itemId) return;
            const chosen = items.find((i) => i.Id === itemId);
            if (chosen) {
              await this.loadJellyfinMedia(base, token, chosen);
            }
          };
        } catch (err) {
          jfStatus.textContent = `Jellyfin error: ${err.message}. (Ensure CORS is permitted).`;
        }
      });
    }
  }

  async loadJellyfinMedia(serverUrl, token, item) {
    const jfStatus = document.getElementById("jf-status");
    try {
      jfStatus.textContent = `Fetching Jellyfin subtitles & trickplay for "${item.Name}"…`;

      // Get item details
      const detailRes = await fetch(`${serverUrl}/Items/${item.Id}/PlaybackInfo`, {
        method: "POST",
        headers: {
          Authorization: `MediaBrowser Token="${token}"`,
          "Content-Type": "application/json",
        },
      });

      const playbackInfo = await detailRes.json();
      const mediaSource = playbackInfo.MediaSources?.[0];
      const subStream = mediaSource?.MediaStreams?.find((s) => s.Type === "Subtitle");

      let srtText = "";
      if (subStream) {
        // Jellyfin converts embedded subtitles on the fly!
        const subRes = await fetch(`${serverUrl}/Videos/${item.Id}/${mediaSource.Id}/Subtitles/${subStream.Index}/Stream.srt`, {
          headers: { Authorization: `MediaBrowser Token="${token}"` },
        });
        if (subRes.ok) srtText = await subRes.text();
      }

      // Check trickplay manifest
      const tpRes = await fetch(`${serverUrl}/Items/${item.Id}/Trickplay/1000`, {
        headers: { Authorization: `MediaBrowser Token="${token}"` },
      });

      if (!tpRes.ok) {
        throw new Error("Jellyfin trickplay manifest not found. Verify Trickplay generation is enabled in Jellyfin.");
      }

      const tpInfo = await tpRes.json();
      // Setup timeline for Jellyfin
      const frameCount = tpInfo.TileCount || 100;
      const intervalMs = tpInfo.Interval || 10000;
      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        frames.push({
          index: i,
          tsMs: i * intervalMs,
          offset: 0,
          length: 0,
        });
      }

      this.timeline = {
        frameCount,
        multiplierMs: intervalMs,
        durationMs: frameCount * intervalMs,
        frames,
      };

      // Custom fetcher for Jellyfin tile crops
      this.customFrameFetcher = async (frameIdx) => {
        const perSheet = tpInfo.TileWidth * tpInfo.TileHeight;
        const sheetIdx = Math.floor(frameIdx / perSheet);
        const tileUrl = `${serverUrl}/Items/${item.Id}/Trickplay/1000/${sheetIdx}.jpg`;
        return tileUrl;
      };

      this.subtitles = parseSrt(srtText);
      this.durationMs = this.timeline.durationMs;
      this.currentTimeMs = 0;
      this.bifBuffer = null;

      if (this.slider) {
        this.slider.min = 0;
        this.slider.max = this.durationMs;
        this.slider.value = 0;
      }

      this.buildScenes();
      await this.updateFrameAt(0);
      this.updateUI();
      this.setStatus(`Playing from Jellyfin: ${item.Name}`);
      jfStatus.textContent = `Loaded "${item.Name}" successfully!`;
    } catch (err) {
      jfStatus.textContent = `Error: ${err.message}`;
    }
  }
}

// Auto-initialize when document loads in browser
if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    const player = new TrickplayerWeb();
    player.loadDemo();
    window.trickplayer = player;
  });
}

