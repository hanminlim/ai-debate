// 릴리즈 빌드에서 터미널 창을 띄우지 않는다
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_debate_lib::run()
}
