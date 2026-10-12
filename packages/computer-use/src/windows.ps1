$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

try {
  $rawRequest = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawRequest)) {
    throw 'A JSON request is required.'
  }

  $request = ConvertFrom-Json -InputObject $rawRequest
  $action = [string]$request.action
  $argsObject = $request.args
  if ($null -eq $argsObject) { $argsObject = [pscustomobject]@{} }

  if ($action -notin @('windows', 'snapshot', 'click', 'type', 'key', 'scroll')) {
    throw 'Unsupported Windows action.'
  }

  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class T3CuaNative
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint Type;
        public INPUTUNION U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT Mouse;
        [FieldOffset(0)] public KEYBDINPUT Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachState);

    [DllImport("user32.dll", EntryPoint = "PeekMessageW", SetLastError = true)]
    private static extern bool PeekMessageNative(out MSG message, IntPtr hWnd, uint minMessage, uint maxMessage, uint remove);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetForegroundWindow();

    public static bool TrySetForegroundWindowWithInputAttach(IntPtr hWnd)
    {
        IntPtr foregroundWindow = GetForegroundWindow();
        if (foregroundWindow == hWnd) return true;

        uint foregroundProcessId;
        uint foregroundThreadId = foregroundWindow == IntPtr.Zero
            ? 0
            : GetWindowThreadProcessId(foregroundWindow, out foregroundProcessId);
        uint targetProcessId;
        uint targetThreadId = GetWindowThreadProcessId(hWnd, out targetProcessId);
        uint currentThreadId = GetCurrentThreadId();
        bool attachedToForeground = false;
        bool attachedToTarget = false;
        MSG message;
        // AttachThreadInput requires the current thread to own a message queue.
        PeekMessageNative(out message, IntPtr.Zero, 0, 0, 0);
        try
        {
            if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
                attachedToForeground = AttachThreadInput(currentThreadId, foregroundThreadId, true);
            if (targetThreadId != 0 && targetThreadId != currentThreadId && targetThreadId != foregroundThreadId)
                attachedToTarget = AttachThreadInput(currentThreadId, targetThreadId, true);
            return SetForegroundWindow(hWnd);
        }
        finally
        {
            if (attachedToTarget)
                AttachThreadInput(currentThreadId, targetThreadId, false);
            if (attachedToForeground)
                AttachThreadInput(currentThreadId, foregroundThreadId, false);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr HWnd;
        public uint Message;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public POINT Point;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextLengthW", SetLastError = true)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW", SetLastError = true)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute", PreserveSig = true)]
    private static extern int DwmGetWindowAttributeNative(IntPtr hWnd, uint attribute, out RECT value, uint size);

    public static bool TryGetVisibleFrameBounds(IntPtr hWnd, out RECT rect)
    {
        try
        {
            const uint DWMWA_EXTENDED_FRAME_BOUNDS = 9;
            int result = DwmGetWindowAttributeNative(
                hWnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                out rect,
                (uint)Marshal.SizeOf(typeof(RECT)));
            return result == 0 && rect.Right > rect.Left && rect.Bottom > rect.Top;
        }
        catch (DllNotFoundException)
        {
            rect = new RECT();
            return false;
        }
        catch (EntryPointNotFoundException)
        {
            rect = new RECT();
            return false;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", EntryPoint = "SetProcessDpiAwarenessContext", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContextNative(IntPtr dpiContext);

    [DllImport("user32.dll", EntryPoint = "SetProcessDPIAware", SetLastError = true)]
    private static extern bool SetProcessDPIAwareNative();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    public static uint GetWindowProcessId(IntPtr hWnd)
    {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        return processId;
    }

    public static bool IsWindowAtPoint(IntPtr expectedWindow, int x, int y)
    {
        var point = new POINT();
        point.X = x;
        point.Y = y;
        IntPtr window = WindowFromPoint(point);
        return window != IntPtr.Zero && GetAncestor(window, 2) == expectedWindow;
    }

    public static void EnablePhysicalCoordinates()
    {
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            if (!SetProcessDpiAwarenessContextNative(new IntPtr(-4)))
                SetProcessDPIAwareNative();
        }
        catch (EntryPointNotFoundException)
        {
            SetProcessDPIAwareNative();
        }
    }

    public static string GetWindowTitle(IntPtr hWnd)
    {
        int length = Math.Min(GetWindowTextLengthW(hWnd), 2047);
        if (length <= 0) return String.Empty;
        var text = new StringBuilder(length + 1);
        GetWindowTextW(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static string GetProcessStartStamp(uint processId)
    {
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return null;
            return creation.High.ToString("X8") + creation.Low.ToString("X8");
        }
        finally
        {
            CloseHandle(process);
        }
    }

    private static void SendMouse(uint flags, int data)
    {
        var input = new INPUT();
        input.Type = 0;
        input.U.Mouse.MouseData = unchecked((uint)data);
        input.U.Mouse.Flags = flags;
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows mouse input failed.");
    }

    private static void SendKeyboard(ushort virtualKey, ushort scanCode, uint flags)
    {
        var input = new INPUT();
        input.Type = 1;
        input.U.Keyboard.VirtualKey = virtualKey;
        input.U.Keyboard.ScanCode = scanCode;
        input.U.Keyboard.Flags = flags;
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows keyboard input failed.");
    }

    public static void Click(int button, int clickCount)
    {
        uint down;
        uint up;
        switch (button)
        {
            case 0: down = 0x0002; up = 0x0004; break;
            case 1: down = 0x0008; up = 0x0010; break;
            case 2: down = 0x0020; up = 0x0040; break;
            default: throw new ArgumentOutOfRangeException("button");
        }
        for (int i = 0; i < clickCount; i++)
        {
            SendMouse(down, 0);
            SendMouse(up, 0);
        }
    }

    public static void Scroll(int deltaX, int deltaY)
    {
        if (deltaY != 0) SendMouse(0x0800, deltaY);
        if (deltaX != 0) SendMouse(0x1000, deltaX);
    }

    public static void SendText(string text)
    {
        foreach (char value in text)
        {
            SendKeyboard(0, value, 0x0004);
            SendKeyboard(0, value, 0x0006);
        }
    }

    public static void SendKeyChord(int[] virtualKeys)
    {
        if (virtualKeys == null || virtualKeys.Length == 0)
            throw new ArgumentException("At least one key is required.");
        foreach (int key in virtualKeys) SendKeyboard((ushort)key, 0, 0);
        for (int i = virtualKeys.Length - 1; i >= 0; i--)
            SendKeyboard((ushort)virtualKeys[i], 0, 0x0002);
    }
}
'@ -Language CSharp

  [T3CuaNative]::EnablePhysicalCoordinates()

  function Get-WindowBounds([IntPtr]$Handle) {
    $rect = New-Object T3CuaNative+RECT
    if (-not [T3CuaNative]::TryGetVisibleFrameBounds($Handle, [ref]$rect) -and
        -not [T3CuaNative]::GetWindowRect($Handle, [ref]$rect)) {
      throw 'Could not read the target window bounds.'
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
      throw 'The target window has no visible bounds.'
    }
    return [pscustomobject]@{
      x = [int]$rect.Left
      y = [int]$rect.Top
      width = [int]$width
      height = [int]$height
    }
  }

  function Get-WindowToken([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero -or -not [T3CuaNative]::IsWindow($Handle)) {
      return $null
    }
    $processId = [T3CuaNative]::GetWindowProcessId($Handle)
    if ($processId -eq 0) { return $null }
    $startStamp = [T3CuaNative]::GetProcessStartStamp($processId)
    if ([string]::IsNullOrEmpty($startStamp)) { return $null }
    return 'hwnd:{0};pid:{1};start:{2}' -f $Handle.ToInt64(), $processId, $startStamp
  }

  function Get-TargetWindow([string]$WindowId) {
    if ([string]::IsNullOrWhiteSpace($WindowId) -or $WindowId -notmatch '^hwnd:(?<hwnd>-?\d+);pid:(?<pid>\d+);start:(?<start>[0-9A-Fa-f]{16})$') {
      throw 'windowId must come from a current windows or snapshot result.'
    }
    $handle = [IntPtr]::new([long]$Matches.hwnd)
    $processId = [uint32]$Matches.pid
    $expectedStartStamp = $Matches.start.ToUpperInvariant()
    if (-not [T3CuaNative]::IsWindow($handle)) {
      throw 'The selected window no longer exists.'
    }
    if ([T3CuaNative]::GetWindowProcessId($handle) -ne $processId) {
      throw 'The selected window now belongs to a different process.'
    }
    $actualStartStamp = [T3CuaNative]::GetProcessStartStamp($processId)
    if ([string]::IsNullOrEmpty($actualStartStamp) -or $actualStartStamp -ne $expectedStartStamp) {
      throw 'The selected window process identity changed.'
    }
    if (-not [T3CuaNative]::IsWindowVisible($handle)) {
      throw 'The selected window is no longer visible.'
    }
    return [pscustomobject]@{
      handle = $handle
      windowId = $WindowId
      processId = [int]$processId
      title = [T3CuaNative]::GetWindowTitle($handle)
      bounds = Get-WindowBounds $handle
    }
  }

  function Assert-TargetStillMatches($Target) {
    $currentToken = Get-WindowToken $Target.handle
    if ($null -eq $currentToken -or $currentToken -ne $Target.windowId) {
      throw 'The selected window changed during the action.'
    }
  }

  function Get-VisibleWindows {
    $items = New-Object 'System.Collections.Generic.List[object]'
    $callback = [T3CuaNative+EnumWindowsProc]{
      param([IntPtr]$Handle, [IntPtr]$LParam)
      try {
        if ([T3CuaNative]::IsWindowVisible($Handle)) {
          $title = [T3CuaNative]::GetWindowTitle($Handle)
          $windowId = Get-WindowToken $Handle
          if (-not [string]::IsNullOrWhiteSpace($title) -and $null -ne $windowId) {
            $bounds = Get-WindowBounds $Handle
            [void]$items.Add([pscustomobject]@{
              windowId = $windowId
              title = $title
              processId = [int][T3CuaNative]::GetWindowProcessId($Handle)
              bounds = $bounds
            })
          }
        }
      } catch {
        # An inaccessible or short-lived window is omitted from this snapshot.
      }
      return $true
    }
    [void][T3CuaNative]::EnumWindows($callback, [IntPtr]::Zero)
    return $items.ToArray()
  }

  function Set-TargetForeground($Target) {
    Assert-TargetStillMatches $Target
    if (-not [T3CuaNative]::IsWindowVisible($Target.handle)) {
      throw 'The selected window is no longer visible.'
    }
    if ([T3CuaNative]::IsIconic($Target.handle)) {
      [void][T3CuaNative]::ShowWindow($Target.handle, 9)
    }
    if ([T3CuaNative]::GetForegroundWindow() -ne $Target.handle) {
      [void][T3CuaNative]::SetForegroundWindow($Target.handle)
    }
    if ([T3CuaNative]::GetForegroundWindow() -ne $Target.handle) {
      try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $automationWindow = [System.Windows.Automation.AutomationElement]::FromHandle($Target.handle)
        if ($null -ne $automationWindow) { $automationWindow.SetFocus() }
      } catch {
        # UI Automation focus is a fallback; input still requires the exact HWND to be foreground.
      }
    }
    if ([T3CuaNative]::GetForegroundWindow() -ne $Target.handle) {
      [void][T3CuaNative]::TrySetForegroundWindowWithInputAttach($Target.handle)
    }
    if ([T3CuaNative]::GetForegroundWindow() -ne $Target.handle) {
      throw 'Windows did not allow the selected window to become foreground.'
    }
    Assert-TargetStillMatches $Target
  }

  function Assert-TargetForeground($Target) {
    Assert-TargetStillMatches $Target
    if ([T3CuaNative]::GetForegroundWindow() -ne $Target.handle) {
      throw 'The selected window lost foreground before input was sent.'
    }
  }

  function Assert-TargetAtPoint($Target, [int]$X, [int]$Y) {
    Assert-TargetForeground $Target
    if (-not [T3CuaNative]::IsWindowAtPoint($Target.handle, $X, $Y)) {
      throw 'Another window covers the selected point.'
    }
  }

  function Get-AccessibleText($Target) {
    $parts = New-Object 'System.Collections.Generic.List[string]'
    $parts.Add(('Window: {0}' -f $Target.title))
    $textLength = $parts[0].Length
    try {
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($Target.handle)
      if ($null -eq $root) { return $parts -join "`n" }
      $elements = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Automation]::ControlViewCondition
      )
      $maxElements = [Math]::Min($elements.Count, 180)
      for ($index = 0; $index -lt $maxElements; $index++) {
        try {
          $element = $elements.Item($index)
          $isPassword = [bool]$element.GetCurrentPropertyValue(
            [System.Windows.Automation.AutomationElement]::IsPasswordProperty
          )
          $name = [string]$element.GetCurrentPropertyValue(
            [System.Windows.Automation.AutomationElement]::NameProperty
          )
          $controlType = $element.GetCurrentPropertyValue(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty
          )
          $role = [string]$controlType.ProgrammaticName -replace '^ControlType\.', ''
          $className = [string]$element.GetCurrentPropertyValue(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty
          )
          $isOffscreen = [bool]$element.GetCurrentPropertyValue(
            [System.Windows.Automation.AutomationElement]::IsOffscreenProperty
          )
          $rectangle = $element.GetCurrentPropertyValue(
            [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty
          )
          if (-not $isOffscreen -and $rectangle.Width -gt 0 -and $rectangle.Height -gt 0) {
            $safeName = (($name -replace '[\r\n\t]+', ' ') -replace '"', "'").Trim()
            if ($safeName.Length -gt 240) { $safeName = $safeName.Substring(0, 240) + '...' }
            $cleanName = if ([string]::IsNullOrWhiteSpace($safeName)) { '' } else { ' "{0}"' -f $safeName }
            $safeClassName = ($className -replace '[\r\n\t]+', ' ').Trim()
            if ($safeClassName.Length -gt 120) { $safeClassName = $safeClassName.Substring(0, 120) + '...' }
            $cleanClass = if ([string]::IsNullOrWhiteSpace($safeClassName)) { '' } else { ' class={0}' -f $safeClassName }
            $line = '[{0}]{1}{2} @ x={3} y={4} w={5} h={6}' -f `
              $role, $cleanName, $cleanClass,
              [int][Math]::Round($rectangle.X), [int][Math]::Round($rectangle.Y),
              [int][Math]::Round($rectangle.Width), [int][Math]::Round($rectangle.Height)
            if ($textLength + $line.Length + 1 -le 12000) {
              [void]$parts.Add($line)
              $textLength += $line.Length + 1
            }
          }
          if (-not $isPassword -and $controlType -eq [System.Windows.Automation.ControlType]::Document) {
            try {
              $pattern = $element.GetCurrentPattern(
                [System.Windows.Automation.TextPattern]::Pattern
              )
              $remaining = [Math]::Max(0, 12000 - $textLength - 1)
              $documentText = [string]$pattern.DocumentRange.GetText([Math]::Min($remaining, 6000))
              if (-not [string]::IsNullOrWhiteSpace($documentText)) {
                $documentText = $documentText.Trim()
                if ($documentText.Length -gt 0) {
                  [void]$parts.Add(('Document: ' + $documentText))
                  $textLength += $documentText.Length + 10
                }
              }
            } catch {
              # Text is optional when a control does not expose TextPattern.
            }
          }
          if (-not $isPassword) {
            try {
              $valuePattern = $element.GetCurrentPattern(
                [System.Windows.Automation.ValuePattern]::Pattern
              )
              $value = [string]$valuePattern.Current.Value
              if (-not [string]::IsNullOrWhiteSpace($value)) {
                $value = ($value -replace '[\r\n\t]+', ' ').Trim()
                if ($value.Length -gt 500) { $value = $value.Substring(0, 500) + '...' }
                $valueLine = '  Value: "{0}"' -f $value
                if ($textLength + $valueLine.Length + 1 -le 12000) {
                  [void]$parts.Add($valueLine)
                  $textLength += $valueLine.Length + 1
                }
              }
            } catch {
              # Editable controls do not always expose ValuePattern.
            }
          }
        } catch {
          # Skip a control that disappeared or rejected an accessibility query.
        }
        if ($textLength -ge 12000) { break }
      }
    } catch {
      # A title-only snapshot is still useful when UI Automation is unavailable.
    }
    $text = $parts -join "`n"
    if ($text.Length -gt 12000) { $text = $text.Substring(0, 12000) }
    return $text
  }

  function Capture-TargetImage($Target, [string]$HomeDirectory, [bool]$IncludeBase64) {
    if ([string]::IsNullOrWhiteSpace($HomeDirectory) -or -not [IO.Path]::IsPathRooted($HomeDirectory)) {
      throw 'An absolute homeDir is required to save the snapshot image.'
    }
    $captureHome = [IO.Path]::GetFullPath($HomeDirectory)
    $homeRoot = [IO.Path]::GetPathRoot($captureHome)
    if ($captureHome -ne $homeRoot) {
      $captureHome = $captureHome.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    }
    if ([string]::IsNullOrWhiteSpace($captureHome)) { throw 'homeDir is invalid.' }
    $directory = [IO.Path]::GetFullPath((Join-Path $captureHome 'computer-use\screenshots'))
    $prefix = if ($captureHome.EndsWith([IO.Path]::DirectorySeparatorChar)) { $captureHome } else { $captureHome + [IO.Path]::DirectorySeparatorChar }
    if (-not $directory.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Screenshot directory must remain under homeDir.'
    }
    [void][IO.Directory]::CreateDirectory($directory)

    $bounds = Get-WindowBounds $Target.handle
    $pixelCount = [long]$bounds.width * [long]$bounds.height
    if ($bounds.width -gt 8192 -or $bounds.height -gt 8192 -or $pixelCount -gt 16000000) {
      throw 'The selected window is too large to capture safely.'
    }
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object System.Drawing.Bitmap($bounds.width, $bounds.height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      if ([T3CuaNative]::GetForegroundWindow() -eq $Target.handle) {
        # Screen coordinates and GetWindowRect are physical pixels after enabling
        # per-monitor DPI awareness. Capturing the visible target avoids PrintWindow
        # returning a logical-size surface for a DPI-unaware application.
        $graphics.CopyFromScreen($bounds.x, $bounds.y, 0, 0, $bitmap.Size)
      } else {
        $hdc = $graphics.GetHdc()
        try {
          $printed = [T3CuaNative]::PrintWindow($Target.handle, $hdc, 2)
        } finally {
          $graphics.ReleaseHdc($hdc)
        }
        if (-not $printed) {
          throw 'The selected window could not be captured while occluded.'
        }
      }
      Assert-TargetStillMatches $Target
      $fileName = 'window-{0}.png' -f [Guid]::NewGuid().ToString('N')
      $screenshotPath = [IO.Path]::GetFullPath((Join-Path $directory $fileName))
      if (-not $screenshotPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Screenshot path must remain under homeDir.'
      }
      $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $imageBase64 = $null
      if ($IncludeBase64) {
        $imageBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($screenshotPath))
      }
      return [pscustomobject]@{ path = $screenshotPath; base64 = $imageBase64 }
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  function Get-IntegerArgument($Value, [string]$Name, [int]$Minimum, [int]$Maximum, [bool]$Optional = $false, [int]$Default = 0) {
    if ($null -eq $Value -and $Optional) { return $Default }
    if ($null -eq $Value -or $Value -is [bool]) { throw "$Name must be an integer." }
    $number = 0.0
    if (-not [double]::TryParse([string]$Value, [ref]$number) -or $number -ne [Math]::Truncate($number) -or $number -lt $Minimum -or $number -gt $Maximum) {
      throw "$Name is outside the supported integer range."
    }
    return [int]$number
  }

  function Get-KeyVirtualCode([string]$Key) {
    $name = $Key.Trim().ToUpperInvariant()
    if ($name -match '^[A-Z0-9]$') { return [int][char]$name }
    if ($name -match '^F(?<number>\d{1,2})$') {
      $number = [int]$Matches.number
      if ($number -ge 1 -and $number -le 24) { return 0x6F + $number }
    }
    $map = @{
      CTRL = 0x11; CONTROL = 0x11; SHIFT = 0x10; ALT = 0x12
      ENTER = 0x0D; RETURN = 0x0D; TAB = 0x09; SPACE = 0x20
      ESC = 0x1B; ESCAPE = 0x1B; BACKSPACE = 0x08; DELETE = 0x2E
      INSERT = 0x2D; HOME = 0x24; END = 0x23; PAGEUP = 0x21
      PAGEDOWN = 0x22; UP = 0x26; DOWN = 0x28; LEFT = 0x25; RIGHT = 0x27
      CAPSLOCK = 0x14; NUMLOCK = 0x90; COMMA = 0xBC; PERIOD = 0xBE
      MINUS = 0xBD; EQUALS = 0xBB; SLASH = 0xBF; BACKSLASH = 0xDC
      SEMICOLON = 0xBA; QUOTE = 0xDE; LEFTBRACKET = 0xDB; RIGHTBRACKET = 0xDD
    }
    if ($map.ContainsKey($name)) { return [int]$map[$name] }
    if ($name -in @('WIN', 'WINDOWS', 'META', 'SUPER', 'OS', 'COMMAND', 'CMD')) {
      throw 'Windows and system keys are not supported.'
    }
    throw 'Unsupported key name.'
  }

  if ($action -eq 'windows') {
    $windows = @(Get-VisibleWindows)
    $foreground = Get-WindowToken ([T3CuaNative]::GetForegroundWindow())
    $result = [pscustomobject]@{ windows = $windows; foregroundWindowId = $foreground }
  } else {
    $target = Get-TargetWindow ([string]$argsObject.windowId)
    if ($action -eq 'snapshot') {
      $includeImage = $false
      if ($null -ne $argsObject.includeImage) {
        if ($argsObject.includeImage -isnot [bool]) { throw 'includeImage must be a boolean.' }
        $includeImage = [bool]$argsObject.includeImage
      }
      $text = Get-AccessibleText $target
      Assert-TargetStillMatches $target
      $image = Capture-TargetImage $target ([string]$request.homeDir) $includeImage
      $target = Get-TargetWindow $target.windowId
      $snapshot = [ordered]@{
        windowId = $target.windowId
        title = $target.title
        bounds = $target.bounds
        text = $text
        screenshotPath = $image.path
        mimeType = 'image/png'
      }
      if ($null -ne $image) { $snapshot.imageBase64 = $image.base64 }
      $result = [pscustomobject]$snapshot
    } elseif ($action -eq 'click') {
      $x = Get-IntegerArgument $argsObject.x 'x' -100000 100000
      $y = Get-IntegerArgument $argsObject.y 'y' -100000 100000
      $clickCount = Get-IntegerArgument $argsObject.clickCount 'clickCount' 1 2 $true 1
      $buttonName = if ($null -eq $argsObject.button) { 'left' } else { [string]$argsObject.button }
      $button = switch ($buttonName.ToLowerInvariant()) { 'left' { 0 } 'right' { 1 } 'middle' { 2 } default { throw 'button must be left, right, or middle.' } }
      Set-TargetForeground $target
      $target = Get-TargetWindow $target.windowId
      $bounds = $target.bounds
      if ($x -lt $bounds.x -or $y -lt $bounds.y -or $x -ge ($bounds.x + $bounds.width) -or $y -ge ($bounds.y + $bounds.height)) {
        throw 'The click point must be inside the selected window.'
      }
      $virtualX = [T3CuaNative]::GetSystemMetrics(76)
      $virtualY = [T3CuaNative]::GetSystemMetrics(77)
      $virtualWidth = [T3CuaNative]::GetSystemMetrics(78)
      $virtualHeight = [T3CuaNative]::GetSystemMetrics(79)
      if ($x -lt $virtualX -or $y -lt $virtualY -or $x -ge ($virtualX + $virtualWidth) -or $y -ge ($virtualY + $virtualHeight)) {
        throw 'The click point is outside the desktop.'
      }
      Assert-TargetStillMatches $target
      if (-not [T3CuaNative]::SetCursorPos($x, $y)) { throw 'Could not move the pointer to the selected window.' }
      Assert-TargetAtPoint $target $x $y
      [T3CuaNative]::Click($button, $clickCount)
      Assert-TargetStillMatches $target
      $result = [pscustomobject]@{ ok = $true; windowId = $target.windowId }
    } elseif ($action -eq 'type') {
      if ($argsObject.text -isnot [string]) { throw 'text must be a string.' }
      $text = [string]$argsObject.text
      if ($text.Length -gt 20000) { throw 'Text exceeds the supported length.' }
      Set-TargetForeground $target
      Assert-TargetForeground $target
      [T3CuaNative]::SendText($text)
      Assert-TargetStillMatches $target
      $result = [pscustomobject]@{ ok = $true; windowId = $target.windowId }
    } elseif ($action -eq 'key') {
      if ($null -eq $argsObject.keys -or $argsObject.keys -is [string]) { throw 'keys must be a non-empty array.' }
      $keyNames = @($argsObject.keys)
      if ($keyNames.Count -lt 1 -or $keyNames.Count -gt 8) { throw 'keys must contain between one and eight names.' }
      $virtualKeys = New-Object 'System.Collections.Generic.List[int]'
      $seen = New-Object 'System.Collections.Generic.HashSet[int]'
      foreach ($keyName in $keyNames) {
        if ($keyName -isnot [string]) { throw 'Every key name must be a string.' }
        $virtualCode = Get-KeyVirtualCode $keyName
        if (-not $seen.Add($virtualCode)) { throw 'A key cannot appear more than once in one chord.' }
        [void]$virtualKeys.Add($virtualCode)
      }
      Set-TargetForeground $target
      Assert-TargetForeground $target
      [T3CuaNative]::SendKeyChord($virtualKeys.ToArray())
      Assert-TargetStillMatches $target
      $result = [pscustomobject]@{ ok = $true; windowId = $target.windowId }
    } elseif ($action -eq 'scroll') {
      $deltaX = Get-IntegerArgument $argsObject.deltaX 'deltaX' -10000 10000 $true 0
      $deltaY = Get-IntegerArgument $argsObject.deltaY 'deltaY' -10000 10000 $true 0
      if ($deltaX -eq 0 -and $deltaY -eq 0) { throw 'At least one scroll delta is required.' }
      Set-TargetForeground $target
      $target = Get-TargetWindow $target.windowId
      if ($null -eq $argsObject.x -and $null -eq $argsObject.y) {
        $x = $target.bounds.x + [int][Math]::Floor($target.bounds.width / 2)
        $y = $target.bounds.y + [int][Math]::Floor($target.bounds.height / 2)
      } elseif ($null -ne $argsObject.x -and $null -ne $argsObject.y) {
        $x = Get-IntegerArgument $argsObject.x 'x' -100000 100000
        $y = Get-IntegerArgument $argsObject.y 'y' -100000 100000
      } else {
        throw 'x and y must be provided together.'
      }
      $bounds = $target.bounds
      if ($x -lt $bounds.x -or $y -lt $bounds.y -or $x -ge ($bounds.x + $bounds.width) -or $y -ge ($bounds.y + $bounds.height)) {
        throw 'The scroll point must be inside the selected window.'
      }
      $virtualX = [T3CuaNative]::GetSystemMetrics(76)
      $virtualY = [T3CuaNative]::GetSystemMetrics(77)
      $virtualWidth = [T3CuaNative]::GetSystemMetrics(78)
      $virtualHeight = [T3CuaNative]::GetSystemMetrics(79)
      if ($x -lt $virtualX -or $y -lt $virtualY -or $x -ge ($virtualX + $virtualWidth) -or $y -ge ($virtualY + $virtualHeight)) {
        throw 'The scroll point is outside the desktop.'
      }
      Assert-TargetStillMatches $target
      if (-not [T3CuaNative]::SetCursorPos($x, $y)) { throw 'Could not move the pointer to the selected window.' }
      Assert-TargetAtPoint $target $x $y
      [T3CuaNative]::Scroll($deltaX, $deltaY)
      Assert-TargetStillMatches $target
      $result = [pscustomobject]@{ ok = $true; windowId = $target.windowId }
    }
  }

  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Depth 8 -Compress))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
