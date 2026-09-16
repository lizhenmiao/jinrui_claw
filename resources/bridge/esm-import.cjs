/**
 * ESM 动态加载助手。
 * 安装包内的主进程是 V8 字节码，bytenode 用 vm.Script 加载、没有 dynamic import 回调，字节码里直接 import() 会报 "A dynamic import callback was not specified."。
 * 本文件随 resources 以明文分发、不参与字节码编译，由主进程 require 进来代为加载 ESM 包。
 */
module.exports = (url) => import(url);
