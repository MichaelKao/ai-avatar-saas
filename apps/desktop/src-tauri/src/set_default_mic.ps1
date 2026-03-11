# 自動切換 Windows 預設錄音裝置
param([string]$Action = "set", [string]$SaveFile = "$env:TEMP\ai-avatar-original-mic.txt")

$code = @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDevEnum {}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
class PolicyCfg {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDevEnum {
    int EnumAudioEndpoints(int flow, int mask, [MarshalAs(UnmanagedType.Interface)] out IDevCol col);
    int GetDefaultAudioEndpoint(int flow, int role, [MarshalAs(UnmanagedType.Interface)] out IDev dev);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDevCol {
    int GetCount(out int c);
    int Item(int i, [MarshalAs(UnmanagedType.Interface)] out IDev d);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDev {
    int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.Interface)] out IPropStore ps);
    int OpenPropertyStore(int mode, [MarshalAs(UnmanagedType.Interface)] out IPropStore ps);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropStore {
    int GetCount(out int c);
    int GetAt(int i, out PKey pk);
    int GetValue(ref PKey key, out PVar pv);
}

[StructLayout(LayoutKind.Sequential)]
public struct PKey {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PVar {
    public ushort vt;
    ushort r1, r2, r3;
    public IntPtr p1;
    public IntPtr p2;
}

[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyCfg {
    int _1(string a, IntPtr b);
    int _2(string a, int b, IntPtr c);
    int _3(string a);
    int _4(string a, IntPtr b, IntPtr c);
    int _5(string a, int b, IntPtr c, IntPtr d);
    int _6(string a, IntPtr b);
    int _7(string a, IntPtr b);
    int _8(string a, IntPtr b);
    int _9(string a, int b, IntPtr c, IntPtr d);
    int _10(string a, int b, IntPtr c, IntPtr d);
    int SetDefaultEndpoint(string id, int role);
}

public class MicSwitch {
    static PKey FriendlyName = new PKey {
        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
        pid = 14
    };

    public static string GetName(IDev dev) {
        try {
            IPropStore ps; dev.OpenPropertyStore(0, out ps);
            PVar pv; ps.GetValue(ref FriendlyName, out pv);
            if (pv.vt == 31 && pv.p1 != IntPtr.Zero)
                return Marshal.PtrToStringUni(pv.p1);
        } catch {}
        return "";
    }

    public static string GetDefaultCaptureId() {
        var en = (IDevEnum)new MMDevEnum();
        IDev dev; en.GetDefaultAudioEndpoint(1, 0, out dev);
        string id; dev.GetId(out id); return id;
    }

    public static string FindCableId() {
        var en = (IDevEnum)new MMDevEnum();
        IDevCol col; en.EnumAudioEndpoints(1, 1, out col);
        int c; col.GetCount(out c);
        for (int i = 0; i < c; i++) {
            IDev d; col.Item(i, out d);
            string name = GetName(d);
            if (name.IndexOf("CABLE", StringComparison.OrdinalIgnoreCase) >= 0) {
                string id; d.GetId(out id);
                return id + "|" + name;
            }
        }
        return "";
    }

    public static void SetDefault(string id) {
        var pc = (IPolicyCfg)new PolicyCfg();
        pc.SetDefaultEndpoint(id, 0);
        pc.SetDefaultEndpoint(id, 2);
    }
}
'@

try { Add-Type -TypeDefinition $code } catch {}

if ($Action -eq "set") {
    $cur = [MicSwitch]::GetDefaultCaptureId()
    Set-Content -Path $SaveFile -Value $cur -NoNewline
    Write-Host "SAVED:$cur"

    $cable = [MicSwitch]::FindCableId()
    if ($cable) {
        $parts = $cable.Split('|')
        $cableId = $parts[0]
        $cableName = $parts[1]
        [MicSwitch]::SetDefault($cableId)
        Write-Host "SET:$cableName"
        Write-Host "OK"
    } else {
        Write-Host "NOTFOUND"
    }
} elseif ($Action -eq "restore") {
    if (Test-Path $SaveFile) {
        $origId = Get-Content -Path $SaveFile -Raw
        if ($origId) {
            [MicSwitch]::SetDefault($origId)
            Remove-Item $SaveFile -ErrorAction SilentlyContinue
            Write-Host "RESTORED"
        }
    } else { Write-Host "NOSAVE" }
}
