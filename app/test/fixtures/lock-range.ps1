# 시험용 (Windows): 파일의 Offset 바이트부터 끝까지를 바이트 범위 잠금(LockFile)으로 잡아요(개발 9회차).
# 다른 프로그램(일부 동기화·백업 도구, 데이터베이스 등)이 파일 일부를 잠근 것과 같아서, 앞부분은 읽히고
# 잠긴 자리를 읽을 때 오류(ERROR_LOCK_VIOLATION, Node에서는 EBUSY)가 나요. 즉 검사가 "읽다 중간에 멈추는" 상황이에요.
# 파일은 읽기·쓰기 공유로 열어서 다른 프로그램이 여는 것은 막지 않고, 내용은 바꾸지 않아요.
# 잠근 뒤 표준 출력에 "locked"를 쓰고, 표준 입력에서 한 줄을 받거나 입력이 끝나면 잠금을 풀고 닫아요.
param([string]$Path, [long]$Offset)
$fs = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'ReadWrite')
try {
  $len = $fs.Length - $Offset
  $fs.Lock($Offset, $len)
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
  $fs.Unlock($Offset, $len)
} finally {
  $fs.Close()
}
