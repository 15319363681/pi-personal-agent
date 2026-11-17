using System;
using System.IO;
using System.Text;
using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class Win32Probe {
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p,IntPtr job,out int result);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static string Q(string s) { return "\"" + s + "\""; }
  static int Main(string[] args) {
    try {
      if (args[0] == "tree") {
        string dir = args[1]; int depth = int.Parse(args[2]);
        Process me = Process.GetCurrentProcess();
        File.WriteAllText(Path.Combine(dir, "pid-" + depth), me.Id + "," + me.StartTime.ToUniversalTime().Ticks);
        if (depth > 0) Process.Start(new ProcessStartInfo { FileName = me.MainModule.FileName, Arguments = "tree " + Q(dir) + " " + (depth - 1), UseShellExecute = false, CreateNoWindow = true });
        Thread.Sleep(Timeout.Infinite); return 0;
      }
      if (args[0] == "boundary") {
        var rows = new List<string>();
        int member; IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out member); rows.Add("in_job="+member);
        IntPtr token; int ac=0,returned; if(!OpenProcessToken(Process.GetCurrentProcess().Handle,8,out token))throw new Exception("OpenProcessToken");
        try{if(!GetTokenInformation(token,29,out ac,4,out returned))throw new Exception("GetTokenInformation");}finally{CloseHandle(token);}
        rows.Add("appcontainer="+ac); rows.Add("pid="+Process.GetCurrentProcess().Id);
        string inside = args[1], outside = args[2], escape = args[3], ro = args[4], host = args[5];
        int tcp = int.Parse(args[6]), udp = int.Parse(args[7]), http = int.Parse(args[8]), https = int.Parse(args[9]);
        Action<string, Action> attempt = (name, operation) => { try { operation(); rows.Add(name + "=ok"); } catch (Exception e) { rows.Add(name + "=denied:" + e.GetType().Name); } };
        attempt("inside_read", () => File.ReadAllText(inside));
        attempt("inside_write", () => File.AppendAllText(inside, "worker\n"));
        attempt("outside_read", () => File.ReadAllText(outside));
        attempt("outside_write", () => File.AppendAllText(outside, "worker\n"));
        attempt("traversal", () => File.ReadAllText(Path.Combine(Path.GetDirectoryName(inside), "..", "outside.txt")));
        attempt("junction", () => File.ReadAllText(escape));
        attempt("readonly_read", () => File.ReadAllText(ro));
        attempt("readonly_write", () => File.AppendAllText(ro, "worker\n"));
        attempt("tcp", () => { using (var c = new TcpClient()) { var r = c.BeginConnect(host, tcp, null, null); if (!r.AsyncWaitHandle.WaitOne(1200)) throw new TimeoutException(); c.EndConnect(r); c.GetStream().WriteByte(80); c.ReceiveTimeout = 1200; if (c.GetStream().ReadByte() != 80) throw new IOException(); } });
        attempt("udp", () => UdpExchange(host, udp, false));
        attempt("dns", () => UdpExchange(host, udp, true));
        attempt("http", () => { var request = (HttpWebRequest) WebRequest.Create("http://" + host + ":" + http + "/probe"); request.Proxy = null; request.Timeout = 1200; using (var r = request.GetResponse()) { using (var s = r.GetResponseStream()) { if (s.ReadByte() != 80) throw new IOException(); } } });
        attempt("https", () => { using (var c = new TcpClient()) { var r = c.BeginConnect(host, https, null, null); if (!r.AsyncWaitHandle.WaitOne(1200)) throw new TimeoutException(); c.EndConnect(r); c.ReceiveTimeout = 1200; using (var s = new SslStream(c.GetStream(), false, (sender, cert, chain, errors) => true)) { s.ReadTimeout = 1200; s.AuthenticateAsClient("pi-spike.invalid", null, System.Security.Authentication.SslProtocols.Tls12, false); s.WriteByte(80); if (s.ReadByte() != 80) throw new IOException(); } } });
        attempt("proxy", () => { var request = (HttpWebRequest) WebRequest.Create("http://pi-spike.invalid/probe"); request.Proxy = new WebProxy("http://" + host + ":" + http); request.Timeout = 1200; using (var r = request.GetResponse()) { using (var s = r.GetResponseStream()) { if (s.ReadByte() != 80) throw new IOException(); } } });
        File.WriteAllLines(args[10], rows);
        int depth=args.Length>11?int.Parse(args[11]):0;
        if(depth>0){var childArgs=(string[])args.Clone();childArgs[10]=args[10]+".child";childArgs[11]=(depth-1).ToString();var quoted=new List<string>();foreach(string s in childArgs)quoted.Add(Q(s));
          using(var child=Process.Start(new ProcessStartInfo{FileName=Process.GetCurrentProcess().MainModule.FileName,Arguments=String.Join(" ",quoted.ToArray()),UseShellExecute=false,CreateNoWindow=true})){if(!child.WaitForExit(20000)||child.ExitCode!=0)throw new Exception("descendant_failed");}}
        return 0;
      }
      return 2;
    } catch (Exception e) { Console.Error.WriteLine(e); return 3; }
  }
  static void UdpExchange(string host, int port, bool dns) {
    using (var c = new UdpClient()) {
      c.Client.ReceiveTimeout = 1200;
      byte[] data = dns ? new byte[] { 0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, 112, 105, 7, 105, 110, 118, 97, 108, 105, 100, 0, 0, 1, 0, 1 } : new byte[] { 80 };
      c.Send(data, data.Length, host, port);
      IPEndPoint endpoint = new IPEndPoint(IPAddress.Any, 0); var result = c.Receive(ref endpoint);
      if (result.Length != data.Length || result[0] != data[0]) throw new IOException();
    }
  }
}
