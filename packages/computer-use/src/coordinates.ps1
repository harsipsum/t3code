function Resolve-T3InputPoint([int]$X, [int]$Y, [string]$CoordinateSpace, $Bounds) {
  if ([string]::IsNullOrEmpty($CoordinateSpace)) { $CoordinateSpace = 'desktop' }
  if ($CoordinateSpace -notin @('desktop', 'window')) {
    throw 'coordinateSpace must be desktop or window.'
  }
  if ($Bounds.width -le 0 -or $Bounds.height -le 0) {
    throw 'The selected window has invalid bounds.'
  }
  $desktopX = [long]$X
  $desktopY = [long]$Y
  if ($CoordinateSpace -eq 'window') {
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $Bounds.width -or $Y -ge $Bounds.height) {
      throw 'The input point must be inside the selected window screenshot.'
    }
    $desktopX += [long]$Bounds.x
    $desktopY += [long]$Bounds.y
  }
  if ($desktopX -lt $Bounds.x -or $desktopY -lt $Bounds.y -or $desktopX -ge ([long]$Bounds.x + $Bounds.width) -or $desktopY -ge ([long]$Bounds.y + $Bounds.height)) {
    throw 'The input point must be inside the selected window.'
  }
  if ($desktopX -lt [int]::MinValue -or $desktopX -gt [int]::MaxValue -or $desktopY -lt [int]::MinValue -or $desktopY -gt [int]::MaxValue) {
    throw 'The input point exceeds the supported desktop coordinate range.'
  }
  return [pscustomobject]@{ x = [int]$desktopX; y = [int]$desktopY }
}
