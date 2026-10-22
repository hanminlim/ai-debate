# 토론 무대

AI 사회자와 토론자들이 내가 낸 문제를 두고 차례로 발언하며 결론을 내는 로컬 웹 앱입니다.
코드 폴더를 지정하면 토론자들이 그 코드를 직접 읽으며 토론합니다.

토론자는 **이 컴퓨터에 로그인한 각자의 Claude 구독**으로 말합니다. API 키를 쓰지 않으므로
따로 과금되지 않고, 본인 구독 사용량에서 차감됩니다. 한도에 걸린 토론자는 무대에서 기절합니다.

## 준비물

- macOS (다른 OS 는 확인하지 않았습니다)
- Node.js 20 이상, Python 3.10 이상
- [Claude Code](https://docs.claude.com/claude-code) 설치와 로그인

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

## 설치와 실행

```bash
npm run setup   # npm 의존성 + 음성 엔진(Supertonic, 모델 약 385MB) 설치
npm run dev     # http://localhost:5173
```

음성 엔진 설치를 건너뛰어도 동작합니다. 이 경우 브라우저 내장 음성으로 읽습니다.

## 쓰는 법

1. 토론에 맡길 문제를 적습니다.
2. 코드에 대해 토론하려면 문제에 프로젝트 이름이나 경로를 적습니다. 예: "xpert-creative-lab 의 인증 구조, 이대로 괜찮을까?"
   시작하면 서버가 흔한 위치(`~/PycharmProjects`, `~/Documents/GitHub`, `~/projects` 등)의 git 프로젝트 폴더 이름만 모으고,
   사회자가 그중 문제에 맞는 하나를 고릅니다. 토론자는 고른 폴더 안만 읽기 전용(Read·Grep·Glob)으로 봅니다.
   쓰기·명령 실행은 할 수 없고 폴더 밖도 읽지 못합니다.
3. 사회자·토론자의 모델, 목소리, 얼굴, 관점을 고르고 시작합니다.
4. 끝나면 "결과 복사"로 결론을 프롬프트 형식으로 복사해 다른 작업에 넘길 수 있습니다.

## 구조

| 파일 | 역할 |
|---|---|
| `server/ask.js` | `claude -p` 호출. 구독 인증만 쓰도록 API 키 환경변수를 지우고, `--restricted` 로 파일 접근을 지정 폴더 안에 가둔다 |
| `server/projects.js` | 프로젝트 폴더 후보 목록(이름만) |
| `server/tts.js` | dev 서버와 함께 Supertonic TTS 서버(127.0.0.1:7788)를 띄운다 |
| `src/engine.js` | 토론 진행. 발언을 대본 이벤트로 내보낸다 |
| `src/script.js` | 대본 이벤트를 화면 상태로 바꾸고, 결과를 프롬프트로 만든다 |
| `src/voice.js` | 음성 생성·재생 |
| `src/avatar.js` | DiceBear avataaars 얼굴 |

```bash
npm test
```

## 라이선스 메모

- 음성: [Supertonic](https://github.com/supertone-inc/supertonic) — 코드 MIT, 모델 OpenRAIL-M
- 얼굴: [DiceBear](https://www.dicebear.com) avataaars — Pablo Stanley 디자인, 개인·상업 사용 무료
