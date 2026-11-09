package com.wastatusvideo.statusdrop.selfhost

/** JNI entry into the embedded nodejs-mobile runtime (see node_runner.cpp). */
object NodeRunner {
    init {
        // Pulls in libnode.so through its NEEDED entry.
        System.loadLibrary("statusdrop_node")
    }

    /** Runs Node until it exits. Can only be called once per process. */
    external fun startNode(arguments: Array<String>): Int
}
