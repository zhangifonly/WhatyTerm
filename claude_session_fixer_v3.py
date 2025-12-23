#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Code 会话修复工具
用于移除会话文件中的 thinking blocks
支持 Windows / macOS / Linux

命令行参数:
  --auto    自动修复最近的会话（无需确认）
  --list    列出最近5个会话
"""

import json
import shutil
import os
import glob
import sys
import argparse


def get_claude_projects_dir():
    """获取 Claude Code 项目目录路径（跨平台）"""
    home = os.path.expanduser("~")
    return os.path.join(home, ".claude", "projects")


def get_recent_sessions(limit=15):
    """获取最近修改的会话文件（排除 agent- 开头的自动生成会话）"""
    projects_dir = get_claude_projects_dir()

    if not os.path.exists(projects_dir):
        return []

    # 查找所有 .jsonl 文件
    search_pattern = os.path.join(projects_dir, "*", "*.jsonl")
    all_files = glob.glob(search_pattern)

    # 按修改时间排序
    files_with_mtime = [(f, os.path.getmtime(f)) for f in all_files]
    files_with_mtime.sort(key=lambda x: x[1], reverse=True)

    # 过滤掉 agent- 开头的会话文件，然后取前 N 条
    filtered_files = [f for f, _ in files_with_mtime
                      if not os.path.basename(f).startswith('agent-')]
    return filtered_files[:limit]


def get_session_preview(filepath, max_user_messages=5):
    """获取会话文件的预览信息

    Args:
        filepath: 会话文件路径
        max_user_messages: 最多显示的用户消息数量（默认5条）
    """
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        preview_info = {
            'total_messages': 0,
            'messages': [],
            'thinking_blocks': 0
        }

        user_message_count = 0

        for line in lines:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                preview_info['total_messages'] += 1

                # 优先收集用户消息
                if 'message' in data:
                    msg = data['message']
                    role = msg.get('role', 'unknown')
                    content = msg.get('content', [])

                    # 统计 thinking blocks
                    if isinstance(content, list):
                        thinking_count = sum(1 for c in content if isinstance(c, dict) and c.get('type') == 'thinking')
                        preview_info['thinking_blocks'] += thinking_count

                    # 只收集真正的用户消息（排除 tool_result）
                    if role == 'user' and user_message_count < max_user_messages:
                        # 检查是否是 tool_result 类型的消息，如果是则跳过
                        is_tool_result = False
                        if isinstance(content, list):
                            for c in content:
                                if isinstance(c, dict) and c.get('type') == 'tool_result':
                                    is_tool_result = True
                                    break

                        # 跳过 tool_result 类型的消息
                        if is_tool_result:
                            continue

                        # 提取文本内容预览（增加长度到500字符）
                        text_content = ""
                        if isinstance(content, str):
                            text_content = content[:500]
                        elif isinstance(content, list):
                            for c in content:
                                if isinstance(c, dict) and c.get('type') == 'text':
                                    text_content = c.get('text', '')[:500]
                                    break

                        # 只有当有实际文本内容时才添加到预览
                        if text_content:
                            preview_info['messages'].append({
                                'role': role,
                                'preview': text_content,
                                'is_first': user_message_count == 0
                            })
                            user_message_count += 1
            except json.JSONDecodeError:
                continue

        # 统计所有 thinking blocks
        if preview_info['thinking_blocks'] == 0:
            for line in lines:
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                    if 'message' in data and 'content' in data['message']:
                        content = data['message']['content']
                        if isinstance(content, list):
                            preview_info['thinking_blocks'] += sum(
                                1 for c in content if isinstance(c, dict) and c.get('type') == 'thinking'
                            )
                except:
                    continue

        return preview_info
    except Exception as e:
        return None


def find_session_by_id(session_id):
    """根据 session ID 在所有项目目录中查找会话文件"""
    projects_dir = get_claude_projects_dir()

    if not os.path.exists(projects_dir):
        return [], projects_dir

    # 确保 session_id 带有 .jsonl 后缀
    if not session_id.endswith('.jsonl'):
        filename = session_id + '.jsonl'
    else:
        filename = session_id

    # 在所有项目子目录中搜索
    search_pattern = os.path.join(projects_dir, "*", filename)
    matches = glob.glob(search_pattern)

    return matches, projects_dir


def fix_session_file(filepath):
    """修复会话文件，移除 thinking blocks"""
    backup_path = filepath + '.backup'
    shutil.copy2(filepath, backup_path)

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        fixed_lines = []
        removed_count = 0

        for line in lines:
            if not line.strip():
                continue
            try:
                data = json.loads(line)
                if 'message' in data and 'content' in data['message']:
                    if isinstance(data['message']['content'], list):
                        original_len = len(data['message']['content'])
                        data['message']['content'] = [
                            c for c in data['message']['content']
                            if not (isinstance(c, dict) and c.get('type') == 'thinking')
                        ]
                        removed_count += original_len - len(data['message']['content'])
                fixed_lines.append(json.dumps(data, ensure_ascii=False) + '\n')
            except json.JSONDecodeError:
                fixed_lines.append(line)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(fixed_lines)

        print(f"\n✓ 处理完成！")
        print(f"  移除了 {removed_count} 个 thinking blocks")
        print(f"  备份文件：{backup_path}")
        return True

    except Exception as e:
        print(f"\n✗ 处理失败：{e}")
        if os.path.exists(backup_path):
            shutil.copy2(backup_path, filepath)
            print("  已从备份恢复原文件")
        return False


def confirm_action(prompt):
    """跨平台的用户确认输入"""
    while True:
        response = input(prompt).strip().lower()
        if response in ('y', 'yes', '是', '确认'):
            return True
        if response in ('n', 'no', '否', '取消'):
            return False
        print("请输入 y/n")


def print_session_info(filepath, index=None):
    """打印会话信息"""
    session_id = os.path.basename(filepath).replace('.jsonl', '')
    project_name = os.path.basename(os.path.dirname(filepath))
    preview = get_session_preview(filepath)

    if index:
        print(f"\n{index}. Session ID: {session_id}")
    else:
        print(f"\nSession ID: {session_id}")

    print(f"   项目: {project_name}")
    print(f"   文件: {filepath}")

    if preview:
        print(f"   消息数: {preview['total_messages']}")
        print(f"   Thinking blocks: {preview['thinking_blocks']}")
        if preview['messages']:
            # 根据场景显示不同的提示文本
            if index:
                # 列表显示模式（选项4）
                print(f"   用户消息预览 (最多显示5条):")
            else:
                # 单个会话显示模式（选项3）
                print(f"   用户消息预览:")
            for i, msg in enumerate(preview['messages'], 1):
                role_cn = {'user': '用户', 'assistant': '助手', 'system': '系统'}.get(msg['role'], msg['role'])
                # 第一条消息显示更多内容（300字符），其他消息显示200字符
                max_len = 300 if msg.get('is_first', False) else 200
                preview_text = msg['preview'][:max_len] if msg['preview'] else '(无文本内容)'

                # 如果文本被截断，添加省略号
                if msg['preview'] and len(msg['preview']) > max_len:
                    preview_text += '...'

                # 多行显示，提高可读性
                print(f"      {i}) [{role_cn}]")
                print(f"         {preview_text}")
    else:
        print("   (无法读取预览信息)")


def main():
    print("=" * 55)
    print("  Claude Code 会话修复工具")
    print("  用于移除会话文件中的 thinking blocks")
    print("=" * 55)
    print()

    # 第一步：获取用户输入
    print("输入方式：")
    print("  1. Session ID (如: 1ccbc4e3-ae4e-48aa-b20d-8b5938d01e7e)")
    print("  2. 完整文件路径")
    print("  3. 自动查找最近的 Session（带确认）")
    print("  4. 列出最近5个 Session 供选择")
    print()

    user_input = input("请选择模式 (1/2/3/4) 或直接输入 Session ID/路径：").strip()
    user_input = user_input.strip('"').strip("'")

    if not user_input:
        print("\n✗ 错误：输入不能为空")
        return 1

    # 处理选项3：自动查找最近的 Session
    if user_input == '3':
        recent_sessions = get_recent_sessions(limit=1)
        if not recent_sessions:
            print("\n✗ 错误：未找到任何会话文件")
            return 1

        filepath = recent_sessions[0]
        print("\n找到最近的会话：")
        print_session_info(filepath)
        print()

        if not confirm_action("确认使用此会话？(y/n): "):
            print("\n已取消操作")
            return 0

        if not confirm_action("是否执行修复？(y/n): "):
            print("\n已取消操作")
            return 0

        if fix_session_file(filepath):
            return 0
        return 1

    # 处理选项4：列出最近5个 Session
    if user_input == '4':
        recent_sessions = get_recent_sessions(limit=5)
        if not recent_sessions:
            print("\n✗ 错误：未找到任何会话文件")
            return 1

        print("\n最近的会话列表：")
        for i, filepath in enumerate(recent_sessions, 1):
            print_session_info(filepath, index=i)

        print()
        choice = input("请选择要修复的会话 (输入序号，多个用逗号分隔，如: 1 或 1,3,5): ").strip()

        if not choice:
            print("\n已取消操作")
            return 0

        # 解析选择（支持中英文逗号）
        try:
            # 将中文逗号替换为英文逗号，统一处理
            choice = choice.replace('，', ',')
            selected_indices = [int(x.strip()) for x in choice.split(',')]
            selected_files = []

            for idx in selected_indices:
                if 1 <= idx <= len(recent_sessions):
                    selected_files.append(recent_sessions[idx - 1])
                else:
                    print(f"\n✗ 错误：无效的序号 {idx}")
                    return 1

            if not selected_files:
                print("\n✗ 错误：未选择任何会话")
                return 1

            # 确认要修复的会话
            print(f"\n将修复 {len(selected_files)} 个会话:")
            for f in selected_files:
                session_id = os.path.basename(f).replace('.jsonl', '')
                print(f"  - {session_id}")
            print()

            if not confirm_action("确认执行修复？(y/n): "):
                print("\n已取消操作")
                return 0

            # 批量修复
            success_count = 0
            for filepath in selected_files:
                session_id = os.path.basename(filepath).replace('.jsonl', '')
                print(f"\n正在处理: {session_id}")
                if fix_session_file(filepath):
                    success_count += 1

            print(f"\n{'=' * 55}")
            print(f"批量修复完成: 成功 {success_count}/{len(selected_files)}")
            print(f"{'=' * 55}")

            return 0 if success_count == len(selected_files) else 1

        except ValueError:
            print("\n✗ 错误：请输入有效的数字")
            return 1

    # 第二步：查找文件
    # 判断是路径还是 Session ID
    is_path = (os.path.sep in user_input or
               '/' in user_input or
               '\\' in user_input or
               user_input.endswith('.jsonl') and os.path.exists(user_input))

    if is_path:
        # 直接使用路径
        filepath = user_input
        if not os.path.exists(filepath):
            print(f"\n✗ 错误：文件不存在")
            print(f"  路径：{filepath}")
            return 1
        if not filepath.endswith('.jsonl'):
            print(f"\n✗ 错误：请指定 .jsonl 文件")
            return 1
        print(f"\n✓ 找到文件：{filepath}")
    else:
        # Session ID 模式，搜索文件
        print(f"\n正在查找 Session ID: {user_input} ...")
        matches, projects_dir = find_session_by_id(user_input)

        if not matches:
            print(f"\n✗ 未找到匹配的会话文件")
            print(f"  搜索目录：{projects_dir}")
            if not os.path.exists(projects_dir):
                print(f"  （目录不存在，请确认 Claude Code 已正确安装）")
            return 1

        if len(matches) == 1:
            filepath = matches[0]
            print(f"\n✓ 找到文件：{filepath}")
        else:
            # 多个匹配
            print(f"\n找到 {len(matches)} 个匹配文件：")
            for i, path in enumerate(matches, 1):
                # 提取项目名称方便识别
                project_name = os.path.basename(os.path.dirname(path))
                print(f"  {i}. [{project_name}]")
                print(f"     {path}")
            print()

            choice = input("请选择文件编号：").strip()
            try:
                idx = int(choice) - 1
                if 0 <= idx < len(matches):
                    filepath = matches[idx]
                else:
                    print("\n✗ 错误：无效的选择")
                    return 1
            except ValueError:
                print("\n✗ 错误：请输入有效的数字")
                return 1

    # 第三步：确认修复
    print()
    if not confirm_action("是否执行修复？(y/n): "):
        print("\n已取消操作")
        return 0

    # 第四步：执行修复
    if fix_session_file(filepath):
        return 0
    return 1


if __name__ == '__main__':
    print("=" * 55)
    print("  Claude Code 会话修复工具")
    print("  自动修复最近5个会话的 thinking blocks")
    print("=" * 55)
    print()

    recent_sessions = get_recent_sessions(limit=5)
    if not recent_sessions:
        print("未找到任何会话文件")
        sys.exit(1)

    print(f"找到 {len(recent_sessions)} 个会话，开始修复...\n")

    success_count = 0
    for i, filepath in enumerate(recent_sessions, 1):
        session_id = os.path.basename(filepath).replace('.jsonl', '')
        preview = get_session_preview(filepath)
        thinking_count = preview['thinking_blocks'] if preview else 0

        print(f"[{i}/{len(recent_sessions)}] {session_id[:20]}...")
        print(f"    Thinking blocks: {thinking_count}")

        if thinking_count == 0:
            print("    跳过 (无需修复)")
        else:
            if fix_session_file(filepath):
                success_count += 1
        print()

    print("=" * 55)
    print(f"完成! 共处理 {len(recent_sessions)} 个会话")
    print("=" * 55)
    sys.exit(0)
