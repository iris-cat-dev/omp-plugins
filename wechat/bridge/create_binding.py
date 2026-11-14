"""Create a binding only for an explicitly selected account, PID and contact database."""
import argparse
import json
import os
from pathlib import Path

import psutil

from receiver import identifier, integer
from readonly.process import SelectedProcess


def create_binding(account_id, pid, contact_database, output, *, allow_read=False):
    if allow_read is not True:
        raise ValueError('必须明确授权读取所选微信进程和数据库。')
    identifier(account_id, account=True)
    integer(pid, positive=True)
    contact, destination = Path(contact_database), Path(output)
    if not contact.is_absolute() or not destination.is_absolute():
        raise ValueError('联系人数据库和绑定文件必须使用绝对路径。')
    if contact.name != 'contact.db' or contact.parent.name != 'contact' or contact.parent.parent.name != 'db_storage':
        raise ValueError('联系人数据库必须为 db_storage/contact/contact.db。')
    contact = contact.resolve(strict=True)
    created_at_ms = round(psutil.Process(pid).create_time() * 1000)
    integer(created_at_ms, positive=True)
    binding = {'accountId': account_id, 'pid': pid, 'createdAtMs': created_at_ms,
               'contactDatabaseFiles': [str(contact)]}
    process = SelectedProcess(account_id, pid, created_at_ms)
    try:
        if contact not in process.keys([contact]):
            raise ValueError('所选进程无法认证指定联系人数据库。')
        process.verify()
        if contact.resolve(strict=True) != contact:
            raise ValueError('联系人数据库路径已变化。')
        # Never replace an existing binding; callers must choose a new path.
        with open(destination, 'x', encoding='utf-8', newline='\n') as stream:
            json.dump(binding, stream, ensure_ascii=False, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        process.close()
    return binding


def main():
    parser = argparse.ArgumentParser(description='为明确指定的微信进程和联系人数据库创建绑定')
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--contact-database', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--allow-read', action='store_true', required=True,
                        help='授权只读核验指定进程和数据库')
    args = parser.parse_args()
    create_binding(args.account_id, args.pid, args.contact_database, args.output,
                   allow_read=args.allow_read)
    print('绑定已创建。')


if __name__ == '__main__':
    main()
