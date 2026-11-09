// Starts the embedded Node.js runtime (nodejs-mobile) for StatusDrop's
// self-host bot. Called once per ":selfhost" process from SelfHostService;
// Node cannot be started twice in the same process, so the service kills its
// process when Node exits.

#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

const char *kTag = "StatusDropNode";
int stdout_pipe[2];
int stderr_pipe[2];

void *pump(void *arg) {
    const int fd = *static_cast<int *>(arg);
    const int priority = fd == stderr_pipe[0] ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    char buffer[2048];
    ssize_t count;
    while ((count = read(fd, buffer, sizeof(buffer) - 1)) > 0) {
        if (buffer[count - 1] == '\n') --count;
        buffer[count] = '\0';
        __android_log_write(priority, kTag, buffer);
    }
    return nullptr;
}

// Node writes to stdout/stderr; forward both to logcat.
void redirect_output_to_logcat() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(stdout_pipe) == 0 && pipe(stderr_pipe) == 0) {
        dup2(stdout_pipe[1], STDOUT_FILENO);
        dup2(stderr_pipe[1], STDERR_FILENO);
        pthread_t out_thread;
        pthread_t err_thread;
        if (pthread_create(&out_thread, nullptr, pump, &stdout_pipe[0]) == 0) pthread_detach(out_thread);
        if (pthread_create(&err_thread, nullptr, pump, &stderr_pipe[0]) == 0) pthread_detach(err_thread);
    } else {
        __android_log_write(ANDROID_LOG_ERROR, kTag, "Could not redirect Node output to logcat.");
    }
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_wastatusvideo_statusdrop_selfhost_NodeRunner_startNode(JNIEnv *env, jobject /* this */, jobjectArray arguments) {
    static bool started = false;
    if (started) {
        __android_log_write(ANDROID_LOG_ERROR, kTag, "Node was already started in this process.");
        return -1;
    }
    started = true;

    const jsize count = env->GetArrayLength(arguments);
    std::vector<std::string> values;
    values.reserve(count);
    size_t total = 0;
    for (jsize i = 0; i < count; ++i) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *chars = env->GetStringUTFChars(item, nullptr);
        values.emplace_back(chars);
        env->ReleaseStringUTFChars(item, chars);
        env->DeleteLocalRef(item);
        total += values.back().size() + 1;
    }

    // libuv requires all argv strings to sit in one contiguous block.
    char *block = static_cast<char *>(calloc(total, 1));
    std::vector<char *> argv(count);
    char *cursor = block;
    for (jsize i = 0; i < count; ++i) {
        memcpy(cursor, values[i].c_str(), values[i].size() + 1);
        argv[i] = cursor;
        cursor += values[i].size() + 1;
    }

    redirect_output_to_logcat();
    const int exit_code = node::Start(static_cast<int>(count), argv.data());
    __android_log_print(ANDROID_LOG_INFO, kTag, "Node exited with code %d", exit_code);
    return exit_code;
}
