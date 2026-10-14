Add-Type -AssemblyName System.Drawing
$root=Join-Path $PSScriptRoot "assets"
New-Item -ItemType Directory -Force -Path $root | Out-Null
function New-SideraBitmap([int]$size) {
  [float]$r=[float]$size
  $bmp=[System.Drawing.Bitmap]::new($size,$size)
  $bmp.SetResolution(96,96)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  [float]$m=$r*0.045; [float]$rad=$r*0.22; [float]$d=$rad*2
  $bgPath=[System.Drawing.Drawing2D.GraphicsPath]::new()
  $bgPath.AddArc($m,$m,$d,$d,180,90); $bgPath.AddArc($r-$m-$d,$m,$d,$d,270,90)
  $bgPath.AddArc($r-$m-$d,$r-$m-$d,$d,$d,0,90); $bgPath.AddArc($m,$r-$m-$d,$d,$d,90,90); $bgPath.CloseFigure()
  $rect=[System.Drawing.RectangleF]::new($m,$m,$r-2*$m,$r-2*$m)
  $bg=[System.Drawing.Drawing2D.LinearGradientBrush]::new($rect,[System.Drawing.Color]::FromArgb(255,16,42,76),[System.Drawing.Color]::FromArgb(255,4,16,31),45)
  $g.FillPath($bg,$bgPath)
  $outline=[System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(120,77,156,255),[float]($r*0.006))
  $g.DrawPath($outline,$bgPath)
  $state=$g.Save()
  $g.TranslateTransform($r*0.50,$r*0.50); $g.RotateTransform(-20); $g.TranslateTransform(-$r*0.50,-$r*0.50)
  $orbit=[System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(235,91,173,255),[float]($r*0.032))
  $orbit.StartCap=[System.Drawing.Drawing2D.LineCap]::Round; $orbit.EndCap=[System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($orbit,$r*0.18,$r*0.31,$r*0.64,$r*0.36,12,314)
  $g.Restore($state)
  $dotBrush=[System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255,190,226,255))
  $g.FillEllipse($dotBrush,$r*0.765,$r*0.305,$r*0.060,$r*0.060)
  [float]$cx=$r*0.50; [float]$cy=$r*0.46
  [System.Drawing.PointF[]]$pts=@(
    [System.Drawing.PointF]::new($cx,$r*0.17),
    [System.Drawing.PointF]::new($r*0.55,$r*0.39),
    [System.Drawing.PointF]::new($r*0.76,$cy),
    [System.Drawing.PointF]::new($r*0.55,$r*0.53),
    [System.Drawing.PointF]::new($cx,$r*0.82),
    [System.Drawing.PointF]::new($r*0.45,$r*0.53),
    [System.Drawing.PointF]::new($r*0.24,$cy),
    [System.Drawing.PointF]::new($r*0.45,$r*0.39)
  )
  $starRect=[System.Drawing.RectangleF]::new($r*0.25,$r*0.17,$r*0.50,$r*0.65)
  $star=[System.Drawing.Drawing2D.LinearGradientBrush]::new($starRect,[System.Drawing.Color]::White,[System.Drawing.Color]::FromArgb(255,112,170,255),45)
  $g.FillPolygon($star,$pts)
  $g.Dispose(); $bg.Dispose(); $outline.Dispose(); $orbit.Dispose(); $dotBrush.Dispose(); $star.Dispose(); $bgPath.Dispose()
  return $bmp
}
$png=Join-Path $root 'sidera.png'
$ico=Join-Path $root 'sidera.ico'
$b512=New-SideraBitmap 512
$b512.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
$b256=New-SideraBitmap 256
$h=$b256.GetHicon()
$icon=[System.Drawing.Icon]::FromHandle($h)
$fs=[System.IO.File]::Create($ico)
$icon.Save($fs); $fs.Close()
$b512.Dispose(); $b256.Dispose()
Write-Output "PNG=$png $((Get-Item $png).Length)"
Write-Output "ICO=$ico $((Get-Item $ico).Length)"

