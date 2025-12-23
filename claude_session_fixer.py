import json
import shutil
import os

def fix_session_file(filepath):
    if not os.path.exists(filepath):
        print("错误：文件不存在")
        return False

    if not filepath.endswith('.jsonl'):
        print("错误：请输入 .jsonl 文件")
        return False

    backup_path = filepath + '.backup'
    shutil.copy2(filepath, backup_path)

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        fixed_lines = []
        for line in lines:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                if 'message' in data and 'content' in data['message']:
                    if isinstance(data['message']['content'], list):
                        data['message']['content'] = [
                            c for c in data['message']['content']
                            if not (isinstance(c, dict) and c.get('type') == 'thinking')
                        ]
                fixed_lines.append(json.dumps(data, ensure_ascii=False) + '\n')
            except json.JSONDecodeError:
                fixed_lines.append(line)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(fixed_lines)

        print("处理完成！")
        print(f"备份文件：{backup_path}")
        return True

    except Exception as e:
        print(f"处理失败：{e}")
        if os.path.exists(backup_path):
            shutil.copy2(backup_path, filepath)
            print("已从备份恢复原文件")
        return False

def main():
    print("=" * 50)
    print("Claude Code 会话修复工具")
    print("用于移除会话文件中的 thinking blocks")
    print("=" * 50)
    print()

    filepath = input("请输入会话文件完整路径：").strip()
    filepath = filepath.strip('"').strip("'")

    if not filepath:
        print("错误：路径不能为空")
        return

    print()
    fix_session_file(filepath)

if __name__ == '__main__':
    main()
