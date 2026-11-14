"""Public errors deliberately contain no source-specific information."""

_MESSAGES = {
    "INVALID_INPUT": "读取参数无效，请检查显式账号目录、账号和密钥格式。",
    "ACCOUNT_NOT_FOUND": "指定账号数据库目录不存在。",
    "DATABASE_NOT_FOUND": "所需数据库不存在，请确认账号数据完整。",
    "INVALID_KEY": "密钥无法通过数据库认证，请重新获取该账号的密钥。",
    "SNAPSHOT_CHANGED": "数据库正在变化，无法取得一致快照，请稍后重试。",
    "INVALID_DATABASE": "数据库快照损坏或超出读取限制。",
    "INVALID_WAL": "数据库日志未通过完整性验证。",
    "UNSUPPORTED_SCHEMA": "当前数据库结构不受支持，不能安全读取。",
    "CONTENT_DECODE_FAILED": "消息正文无法完整解码。",
    "DEPENDENCY_MISSING": "缺少数据库解密或消息解压依赖。",
    "CLOSED": "数据库读取器已经关闭。",
    "IO_ERROR": "无法访问数据库或私有工作目录。",
}


class ReaderError(Exception):
    def __init__(self, code: str):
        self.code = code if code in _MESSAGES else "INVALID_DATABASE"
        super().__init__(_MESSAGES[self.code])
