// audio-device-manager.js — WASAPI endpoint enumeration & monitoring.
//
// Enumerates real Windows audio endpoints (render + capture) through the
// IMMDeviceEnumerator COM API (the same API the native loopback addon uses
// under the hood). Runs a C# COM-interop helper in PowerShell, in keeping
// with this repo's existing pattern for Windows queries. Polls so default
// device switches / plugs / unplugs are detected and surfaced to the
// capture layer, which can then restart on the right endpoint.
'use strict';

const { spawn } = require('child_process');

// C# helper: enumerate endpoints, default device, friendly names, mix
// formats and Bluetooth classification. Emitted as a JSON array.
const CSHARP_ENUM = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class WasapiDevices
{
    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(2)] public ushort wReserved1;
        [FieldOffset(4)] public ushort wReserved2;
        [FieldOffset(6)] public ushort wReserved3;
        [FieldOffset(8)] public IntPtr pwszVal;
        [FieldOffset(8)] public int i4Val;
        [FieldOffset(8)] public uint u4Val;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");

    static readonly PROPERTYKEY PKEY_Device_FriendlyName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    static readonly PROPERTYKEY PKEY_Device_EnumeratorName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 24 };
    static readonly PROPERTYKEY PKEY_Device_BusReportedDeviceDesc = new PROPERTYKEY { fmtid = new Guid("540b947e-8b40-45bc-a8a2-6a0b89cbdac4"), pid = 4 };
    static readonly PROPERTYKEY PKEY_AudioEndpoint_FormFactor = new PROPERTYKEY { fmtid = new Guid("1da5d803-d492-4edd-8c23-e0c0ffee7f0e"), pid = 0 };

    // --- COM vtable dispatch (methods are positionally in the interface) ---
    delegate int DEnumEndpoints(IntPtr self, int dataFlow, int stateMask, out IntPtr collection);
    delegate int DGetCount(IntPtr self, out uint count);
    delegate int DGetItem(IntPtr self, uint index, out IntPtr dev);
    delegate int DGetDefault(IntPtr self, int dataFlow, int role, out IntPtr dev);
    delegate int DGetId(IntPtr self, out IntPtr pwstr);
    delegate int DGetState(IntPtr self, out int state);
    delegate int DOpenStore(IntPtr self, int stgmAccess, out IntPtr store);
    delegate int DGetValue(IntPtr self, ref PROPERTYKEY key, out PROPVARIANT pv);
    delegate int DActivate(IntPtr self, ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr iface);
    delegate int DGetMixFormat(IntPtr self, out IntPtr ppFormat);

    static IntPtr CoCreate(string clsid)
    {
        Type t = Type.GetTypeFromCLSID(new Guid(clsid));
        return Marshal.GetIUnknownForObject(Activator.CreateInstance(t));
    }

    static T Fn<T>(IntPtr obj, int slot)
    {
        IntPtr vtbl = Marshal.ReadIntPtr(obj);
        IntPtr fn = Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
    }

    static IntPtr OpenStore(IntPtr dev)
    {
        IntPtr store;
        if (Fn<DOpenStore>(dev, 4)(dev, 0, out store) != 0) return IntPtr.Zero;
        return store;
    }

    static string ReadStringValue(IntPtr store, PROPERTYKEY key)
    {
        PROPVARIANT pv;
        if (Fn<DGetValue>(store, 5)(store, ref key, out pv) != 0 || pv.vt != 31) return "";
        return Marshal.PtrToStringUni(pv.pwszVal) ?? "";
    }

    static uint ReadUintValue(IntPtr store, PROPERTYKEY key)
    {
        PROPVARIANT pv;
        if (Fn<DGetValue>(store, 5)(store, ref key, out pv) != 0) return 0;
        if (pv.vt == 3) return (uint)pv.i4Val;
        if (pv.vt == 19) return pv.u4Val;
        return 0;
    }

    static string GetStringProp(IntPtr dev, PROPERTYKEY key)
    {
        IntPtr store = OpenStore(dev);
        if (store == IntPtr.Zero) return "";
        string v = ReadStringValue(store, key);
        Marshal.Release(store);
        return v;
    }

    static uint GetUintProp(IntPtr dev, PROPERTYKEY key)
    {
        IntPtr store = OpenStore(dev);
        if (store == IntPtr.Zero) return 0;
        uint v = ReadUintValue(store, key);
        Marshal.Release(store);
        return v;
    }

    static string GetDeviceId(IntPtr dev)
    {
        IntPtr pId;
        if (Fn<DGetId>(dev, 5)(dev, out pId) != 0 || pId == IntPtr.Zero) return "";
        string s = Marshal.PtrToStringUni(pId) ?? "";
        Marshal.FreeCoTaskMem(pId);
        return s;
    }

    static int GetState(IntPtr dev)
    {
        int s = 1;
        Fn<DGetState>(dev, 6)(dev, out s);
        return s;
    }

    static string FormatInfo(IntPtr dev)
    {
        IntPtr client;
        Guid iid = IID_IAudioClient;
        if (Fn<DActivate>(dev, 3)(dev, ref iid, 23, IntPtr.Zero, out client) != 0 || client == IntPtr.Zero) return "";
        IntPtr pFmt;
        try
        {
            if (Fn<DGetMixFormat>(client, 8)(client, out pFmt) != 0 || pFmt == IntPtr.Zero) return "";
            WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFmt, typeof(WAVEFORMATEX));
            Marshal.FreeCoTaskMem(pFmt);
            return fmt.nChannels + ";" + fmt.nSamplesPerSec + ";" + fmt.wBitsPerSample;
        }
        finally
        {
            Marshal.Release(client);
        }
    }

    static string StateName(int s)
    {
        switch (s)
        {
            case 1: return "active";
            case 2: return "disabled";
            case 4: return "notpresent";
            case 8: return "unplugged";
            default: return "unknown";
        }
    }

    static string JsonStr(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append(" ");
            else sb.Append(c);
        }
        sb.Append("\"");
        return sb.ToString();
    }

    public static string EnumAll()
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("[");
        bool first = true;
        string[] flows = { "render", "capture" };

        for (int flow = 0; flow <= 1; flow++)
        {
            IntPtr enumerator = CoCreate(CLSID_MMDeviceEnumerator.ToString());
            if (enumerator == IntPtr.Zero) continue;
            IntPtr collection = IntPtr.Zero;
            try
            {
                if (Fn<DEnumEndpoints>(enumerator, 3)(enumerator, flow, 9, out collection) != 0 || collection == IntPtr.Zero) continue;

                uint count = 0;
                Fn<DGetCount>(collection, 3)(collection, out count);

                IntPtr defaultDev = IntPtr.Zero;
                string defId = "";
                if (Fn<DGetDefault>(enumerator, 4)(enumerator, flow, 0, out defaultDev) == 0 && defaultDev != IntPtr.Zero)
                    defId = GetDeviceId(defaultDev);

                for (uint i = 0; i < count; i++)
                {
                    IntPtr dev = IntPtr.Zero;
                    try
                    {
                        if (Fn<DGetItem>(collection, 4)(collection, i, out dev) != 0 || dev == IntPtr.Zero) continue;
                        string id = GetDeviceId(dev);
                        string name = GetStringProp(dev, PKEY_Device_FriendlyName);
                        string enumeratorName = GetStringProp(dev, PKEY_Device_EnumeratorName);
                        string busDesc = GetStringProp(dev, PKEY_Device_BusReportedDeviceDesc);
                        uint formFactor = GetUintProp(dev, PKEY_AudioEndpoint_FormFactor);
                        int state = GetState(dev);
                        string fmt = FormatInfo(dev);
                        string[] parts = fmt.Split(';');
                        int ch = 0; uint sr = 0; int bits = 0;
                        if (parts.Length == 3)
                        {
                            int.TryParse(parts[0], out ch);
                            uint.TryParse(parts[1], out sr);
                            int.TryParse(parts[2], out bits);
                        }
                        string blob = enumeratorName + " " + busDesc + " " + name;
                        bool bt = blob.IndexOf("BTHENUM", StringComparison.OrdinalIgnoreCase) >= 0
                               || blob.IndexOf("Bluetooth", StringComparison.OrdinalIgnoreCase) >= 0;

                        if (!first) sb.Append(",");
                        first = false;
                        sb.Append("{\"id\":" + JsonStr(id));
                        sb.Append(",\"flow\":" + JsonStr(flows[flow]));
                        sb.Append(",\"name\":" + JsonStr(name));
                        sb.Append(",\"state\":" + JsonStr(StateName(state)));
                        sb.Append(",\"default\":" + (defId == id ? "true" : "false"));
                        sb.Append(",\"formFactor\":" + formFactor);
                        sb.Append(",\"channels\":" + ch);
                        sb.Append(",\"sampleRate\":" + sr);
                        sb.Append(",\"bitsPerSample\":" + bits);
                        sb.Append(",\"bluetooth\":" + (bt ? "true" : "false"));
                        sb.Append("}");
                    }
                    finally
                    {
                        if (dev != IntPtr.Zero) Marshal.Release(dev);
                    }
                }
                if (defaultDev != IntPtr.Zero) Marshal.Release(defaultDev);
            }
            finally
            {
                if (collection != IntPtr.Zero) Marshal.Release(collection);
                Marshal.Release(enumerator);
            }
        }
        sb.Append("]");
        return sb.ToString();
    }
}
`;

const FORM_FACTOR_NAMES = [
  'RemoteNetworkDevice', 'Speakers', 'LineLevel', 'Headphones',
  'Microphone', 'Headset', 'Handset', 'UnknownDigitalPassthrough',
  'SPDIF', 'DigitalAudioDisplayDevice', 'UnknownFormFactor',
];

function runEnumeration(timeoutMs = 12000) {
  return new Promise((resolve) => {
    const script = "Add-Type -TypeDefinition @'\n" +
      CSHARP_ENUM + "\n'@; [WasapiDevices]::EnumAll()";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch (_) {
        resolve([]);
      }
    });
  });
}

class AudioDeviceManager {
  constructor(options = {}) {
    this.pollMs = options.pollMs || 4000;
    this.devices = [];
    this.defaultRenderId = '';
    this.defaultCaptureId = '';
    this.lastEmit = '';
    this._timer = null;
    this.onDevicesChanged = null;     // (change) => void
    this.onSnapshot = null;           // (snapshot) => void
    this.enumerate = options.enumerate || runEnumeration;
  }

  async start() {
    await this.refresh();
    if (this._timer) return;
    this._timer = setInterval(() => { this.refresh().catch(() => { /* keep polling */ }); }, this.pollMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async refresh() {
    const list = await this.enumerate();
    if (!Array.isArray(list)) return;
    const prev = this.devices;
    this.devices = list;
    this.defaultRenderId = (list.find((d) => d.flow === 'render' && d.default) || {}).id || '';
    this.defaultCaptureId = (list.find((d) => d.flow === 'capture' && d.default) || {}).id || '';

    const change = this.#diff(prev, list);
    if (change.changed) {
      if (this.onDevicesChanged) {
        try { this.onDevicesChanged(change); } catch (_) { /* ignore */ }
      }
    }
    if (this.onSnapshot) {
      try {
        this.onSnapshot({
          devices: list,
          defaultRenderId: this.defaultRenderId,
          defaultCaptureId: this.defaultCaptureId,
        });
      } catch (_) { /* ignore */ }
    }
    return this.snapshot();
  }

  #diff(prev, next) {
    const byId = (arr) => new Map(arr.map((d) => [d.id, d]));
    const p = byId(prev);
    const n = byId(next);
    const added = next.filter((d) => !p.has(d.id));
    const removed = prev.filter((d) => !n.has(d.id));
    const changedState = next.filter((d) => p.has(d.id) && p.get(d.id).state !== d.state);
    const defaultChanged =
      (this.defaultRenderId !== (next.find((d) => d.flow === 'render' && d.default) || {}).id);
    const changed = added.length > 0 || removed.length > 0 || changedState.length > 0 || defaultChanged;
    return {
      changed,
      added,
      removed,
      changedState,
      defaultChanged,
      defaultRenderId: this.defaultRenderId,
    };
  }

  // The render endpoint ID the native system-loopback addon is attached to
  // (it always captures the default render device).
  getActiveRenderId() {
    return this.defaultRenderId;
  }

  getDevices() {
    return this.devices;
  }

  snapshot() {
    return {
      devices: this.devices,
      defaultRenderId: this.defaultRenderId,
      defaultCaptureId: this.defaultCaptureId,
    };
  }
}

module.exports = { AudioDeviceManager, FORM_FACTOR_NAMES };