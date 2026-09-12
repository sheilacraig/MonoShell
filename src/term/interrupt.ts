/**
 * 命令执行期间临时接管终端输入，只做一件事：把 Ctrl+C 翻译成中断回调。
 *
 * 背景：raw 模式下终端不产生 SIGINT，Ctrl+C 只是写进输入流的一个 \x03 字符。
 * 而命令执行期间输入流已被行编辑器 pause 掉、又没有监听者，这个字符会被无声
 * 丢弃 —— 于是「按了 Ctrl+C 没反应」。这里临时 resume 并挂上监听器补上这一环。
 *
 * 两个注意点：
 * - 这个窗口内其它按键会被直接丢弃。真终端里它们本该进子进程 stdin，可这里的
 *   子进程 stdin 早就 end() 了，留着也没有去处，丢弃是当前架构下最不坏的选项。
 * - 返回的 dispose 必须调用（尤其是那一下 pause）：否则行编辑器下一轮 read()
 *   会和这个监听器同时消费输入，一个字符触发两次。
 */
export function watchInterrupt(
  onInterrupt: () => void,
  stdin: NodeJS.ReadStream = process.stdin,
): () => void {
  const onData = (d: Buffer | string) => {
    if (String(d).includes('\x03')) onInterrupt();
  };
  stdin.on('data', onData);
  stdin.resume();
  return () => {
    stdin.removeListener('data', onData);
    stdin.pause();
  };
}
