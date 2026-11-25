#define TBL_SIZE 1024
__kernel void lut_1024_1920(const int width) {
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  float table[TBL_SIZE];
  table[0] = 0.0f;
  float v = table[(x + y * width) % TBL_SIZE];
}
