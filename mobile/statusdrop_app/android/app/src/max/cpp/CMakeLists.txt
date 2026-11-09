cmake_minimum_required(VERSION 3.22.1)
project(statusdrop_node CXX)

# The JNI shim that starts the self-host Node runtime. MAX edition only:
# Gradle passes -DSTATUSDROP_SELFHOST=ON for the max flavor and OFF for
# global, so the Play build gets no native self-host code at all.
option(STATUSDROP_SELFHOST "Build the self-host Node runtime shim" OFF)
if(NOT STATUSDROP_SELFHOST)
    return()
endif()

# libnode.so and its headers come from the nodejs-mobile v18.20.4 Android
# release. Gradle's fetchLibNode task downloads and verifies them into
# android/app/libnode (gitignored) before CMake runs.
set(LIBNODE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(statusdrop_node SHARED node_runner.cpp)
target_include_directories(statusdrop_node PRIVATE ${LIBNODE_DIR}/include/node)
find_library(log-lib log)
target_link_libraries(statusdrop_node libnode ${log-lib})
